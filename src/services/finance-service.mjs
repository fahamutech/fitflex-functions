// Finance service — legacy gym usage/billing summaries, the legacy
// period-based distribution report (read-only: it no longer creates
// invoices), and simple book-keeping (money in vs out).

export function createFinanceService({ gyms, checkins, invoices, users, gymPayouts, settingsService }) {
  /**
   * Smart billing rate logic:
   * - Count consecutive day streaks per member per gym
   * - 4–7 consecutive days → bill at week rate
   * - 3+ consecutive weeks (in a calendar month) → bill at month rate
   * - Otherwise → bill at day rate
   */
  async function computeGymUsageSummaries() {
    const allGyms = gyms.filter(() => true);
    const allCheckins = await checkins.allAsync();
    const summaries = [];

    for (const gym of allGyms) {
      const gymCheckins = allCheckins.filter(c => c.gymId === gym.id);
      if (gymCheckins.length === 0) {
        summaries.push({
          gymId: gym.id, gymName: gym.name, location: gym.location || '',
          totalVisits: 0, uniqueMembers: 0, dayVisits: 0, weekVisits: 0, monthVisits: 0,
          totalOwed: 0, totalPaid: 0, balance: 0
        });
        continue;
      }

      const rateDay = gym.ratePerDay ?? gym.perVisitRate ?? 0;
      const rateWeek = gym.ratePerWeek ?? rateDay * 5;
      const rateMonth = gym.ratePerMonth ?? rateWeek * 3;

      const byMember = {};
      for (const c of gymCheckins) {
        if (!byMember[c.memberId]) byMember[c.memberId] = [];
        byMember[c.memberId].push(c.timestamp);
      }

      let totalOwed = 0;
      let dayCount = 0, weekCount = 0, monthCount = 0;
      const uniqueMembers = new Set();

      for (const [memberId, timestamps] of Object.entries(byMember)) {
        uniqueMembers.add(memberId);
        const dates = [...new Set(timestamps.map(ts => {
          const d = new Date(new Date(ts).getTime() + 3 * 3_600_000);
          return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        }))].sort();

        const streaks = [];
        let streak = [dates[0]];
        for (let i = 1; i < dates.length; i++) {
          const prev = new Date(dates[i - 1]);
          const curr = new Date(dates[i]);
          const diff = (curr - prev) / 86_400_000;
          if (diff === 1) {
            streak.push(dates[i]);
          } else {
            streaks.push(streak);
            streak = [dates[i]];
          }
        }
        streaks.push(streak);

        const monthStreaks = {};
        for (const s of streaks) {
          const monthKey = s[0].slice(0, 7);
          if (!monthStreaks[monthKey]) monthStreaks[monthKey] = [];
          monthStreaks[monthKey].push(s);
        }

        for (const [, mStreaks] of Object.entries(monthStreaks)) {
          const weekStreakCount = mStreaks.filter(s => s.length >= 4).length;

          if (weekStreakCount >= 3) {
            totalOwed += rateMonth;
            monthCount += 1;
          } else {
            for (const s of mStreaks) {
              if (s.length >= 4 && s.length <= 7) {
                totalOwed += rateWeek;
                weekCount += 1;
              } else if (s.length > 7) {
                const weeks = Math.floor(s.length / 7);
                const remainDays = s.length % 7;
                totalOwed += weeks * rateWeek;
                weekCount += weeks;
                if (remainDays >= 4) {
                  totalOwed += rateWeek;
                  weekCount += 1;
                } else {
                  totalOwed += remainDays * rateDay;
                  dayCount += remainDays;
                }
              } else {
                totalOwed += s.length * rateDay;
                dayCount += s.length;
              }
            }
          }
        }
      }

      const paidPayouts = await gymPayouts.filterAsync(p => p.gymId === gym.id && p.status === 'paid');
      const paid = paidPayouts.reduce((sum, p) => sum + (p.amount || 0), 0);

      summaries.push({
        gymId: gym.id, gymName: gym.name, location: gym.location || '',
        totalVisits: gymCheckins.length, uniqueMembers: uniqueMembers.size,
        dayVisits: dayCount, weekVisits: weekCount, monthVisits: monthCount,
        totalOwed: Math.round(totalOwed), totalPaid: paid,
        balance: Math.round(totalOwed) - paid
      });
    }
    return summaries;
  }

  async function gymVisitDetails(gymId) {
    const gym = gyms.find(g => g.id === gymId);
    if (!gym) return { error: 'gym_not_found', status: 404 };

    const gymCheckins = (await checkins.filterAsync(c => c.gymId === gym.id))
      .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));

    const rateDay = gym.ratePerDay ?? gym.perVisitRate ?? 0;

    const records = [];
    for (const c of gymCheckins) {
      const member = await users.findByIdAsync(c.memberId);
      records.push({
        gymId: gym.id,
        gymName: gym.name,
        memberId: c.memberId,
        memberName: member?.displayName || null,
        memberEmail: member?.email || null,
        date: c.timestamp,
        billingType: 'day',
        rate: rateDay
      });
    }
    return { records };
  }

  /** Build payment periods from the earliest checkin to now, each `periodDays` long. */
  async function buildPeriods(periodDays) {
    const allCk = await checkins.allAsync();
    if (allCk.length === 0) return [];
    const earliest = allCk.reduce((m, c) => {
      const d = new Date(c.timestamp);
      return d < m ? d : m;
    }, new Date());
    earliest.setUTCHours(0, 0, 0, 0);
    const now = new Date();
    now.setUTCHours(23, 59, 59, 999);
    const periods = [];
    let cursor = new Date(earliest);
    while (cursor <= now) {
      const end = new Date(cursor.getTime() + periodDays * 86_400_000 - 1);
      const fmt = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      periods.push({ start: fmt(cursor), end: fmt(end > now ? now : end) });
      cursor = new Date(cursor.getTime() + periodDays * 86_400_000);
    }
    return periods;
  }

  async function periodDistribution() {
    const settings = settingsService.ensureDefaultSettings();
    const periodDays = settings.paymentPeriodDays || 14;
    const periods = await buildPeriods(periodDays);
    const allGyms = gyms.filter(() => true);
    const allCheckins = await checkins.allAsync();
    const allInvoices = await invoices.allAsync();

    const result = [];
    for (const period of periods) {
      const pStart = new Date(period.start + 'T00:00:00Z');
      const pEnd = new Date(period.end + 'T23:59:59Z');

      const periodCheckins = allCheckins.filter(c => {
        const d = new Date(c.timestamp);
        return d >= pStart && d <= pEnd;
      });

      const gymBreakdowns = [];
      for (const gym of allGyms) {
        const gymCk = periodCheckins.filter(c => c.gymId === gym.id);
        if (gymCk.length === 0) continue;

        const rateDay = gym.ratePerDay ?? gym.perVisitRate ?? 0;
        const rateWeek = gym.ratePerWeek ?? rateDay * 5;

        const byMember = {};
        for (const c of gymCk) {
          if (!byMember[c.memberId]) byMember[c.memberId] = [];
          byMember[c.memberId].push(c.timestamp);
        }

        let gymOwed = 0;
        const memberDetails = [];

        for (const [memberId, timestamps] of Object.entries(byMember)) {
          const dates = [...new Set(timestamps.map(ts => {
            const d = new Date(new Date(ts).getTime() + 3 * 3_600_000);
            return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
          }))].sort();

          const member = await users.findByIdAsync(memberId);
          let memberOwed = dates.length * rateDay;
          let billingType = 'day';

          if (dates.length >= 4 && dates.length <= 7) {
            memberOwed = rateWeek;
            billingType = 'week';
          } else if (dates.length > 7) {
            const weeks = Math.floor(dates.length / 7);
            const rem = dates.length % 7;
            memberOwed = weeks * rateWeek + (rem >= 4 ? rateWeek : rem * rateDay);
            billingType = 'week';
          }

          gymOwed += memberOwed;
          memberDetails.push({
            memberId,
            memberName: member?.displayName || member?.email || memberId,
            visitCount: dates.length,
            billingType,
            amount: Math.round(memberOwed),
          });
        }

        const invoice = allInvoices.find(i =>
          i.gymId === gym.id && i.periodStart === period.start && i.periodEnd === period.end
        );
        // Legacy invoices are frozen (settlement Phase 3): this report no
        // longer creates one when it is read. New amounts owed to gyms come
        // from the settlement service; existing invoices are still shown.

        const invoicePaid = invoice && invoice.status === 'paid';
        const paid = invoicePaid ? Math.round(gymOwed) : 0;

        gymBreakdowns.push({
          gymId: gym.id,
          gymName: gym.name,
          location: gym.location || '',
          totalVisits: gymCk.length,
          uniqueMembers: Object.keys(byMember).length,
          totalOwed: Math.round(gymOwed),
          totalPaid: paid,
          balance: Math.round(gymOwed) - paid,
          members: memberDetails,
          invoice: invoice || null,
        });
      }

      result.push({
        periodStart: period.start,
        periodEnd: period.end,
        periodDays,
        gyms: gymBreakdowns,
        totalOwed: gymBreakdowns.reduce((s, g) => s + g.totalOwed, 0),
        totalPaid: gymBreakdowns.reduce((s, g) => s + g.totalPaid, 0),
        balance: gymBreakdowns.reduce((s, g) => s + g.balance, 0),
      });
    }

    return result.reverse(); // newest first
  }

  /**
   * @param sponsorPayments optional `async () => rows` of money received from
   *   B2B organisations ({ id, number, amountTzs, reference, receivedAt,
   *   organizationName }). When given, those are the income entries for
   *   sponsors, and the `sponsor_invoice` payment rows that mirror them on a
   *   sponsored pass are left out so the same money is not counted twice.
   */
  async function bookKeeping({ paymentRequests, sponsorPayments = null }) {
    const entries = [];
    const fromSponsors = sponsorPayments ? await sponsorPayments() : null;
    for (const p of fromSponsors ?? []) {
      entries.push({
        id: p.id, date: p.receivedAt, type: 'income', category: 'b2b',
        description: `B2B payment ${p.number} — ${p.organizationName || 'organisation'}`,
        amount: p.amountTzs || 0, reference: p.reference,
      });
    }

    // Batch-fetch approved payments and their members in parallel instead of
    // one findByIdAsync per row (was N+1: ~150 approved payments = ~150
    // sequential DB calls, the actual cause of this endpoint's 349ms time).
    const [approvedPayments, paidInvoices] = await Promise.all([
      paymentRequests.filterByColumnAsync('status', 'approved'),
      invoices.filterByColumnAsync('status', 'paid'),
    ]);

    const memberIds = [...new Set(approvedPayments.map(p => p.memberId).filter(Boolean))];
    const memberRows = await users.filterByColumnInAsync('id', memberIds);
    const memberById = new Map(memberRows.map(u => [u.id, u]));

    for (const p of approvedPayments) {
      if (fromSponsors && p.provider === 'sponsor_invoice') continue;   // counted above, as the organisation's payment
      const member = memberById.get(p.memberId) || null;
      entries.push({
        id: p.id,
        date: p.decidedAt || p.requestedAt,
        type: 'income',
        category: 'subscription',
        description: `${p.tier?.toUpperCase() || 'Pass'} subscription — ${member?.displayName || member?.email || p.memberId}`,
        amount: p.amountTzs || 0,
        reference: p.reference,
        memberId: p.memberId
      });
    }

    for (const inv of paidInvoices) {
      entries.push({
        id: inv.id,
        date: inv.paidAt || inv.createdAt,
        type: 'expense',
        category: 'gym_payout',
        description: `Gym payout — ${inv.gymName || inv.gymId}${inv.periodStart ? ` (${inv.periodStart} – ${inv.periodEnd})` : ''}`,
        amount: inv.amount || 0,
        reference: inv.paymentReference || null,
        gymId: inv.gymId
      });
    }

    // Payouts made through the settlement workflow (a legacy invoice's payout
    // is already counted above through its invoice).
    const settlementPayouts = await gymPayouts.filterAsync(p => p.gymSettlementId && p.status === 'paid');
    for (const p of settlementPayouts) {
      const gym = gyms.find(g => g.id === p.gymId);
      entries.push({
        id: p.id,
        date: p.paidAt || p.createdAt,
        type: 'expense',
        category: 'gym_payout',
        description: `Gym settlement — ${gym?.name || p.gymId}${p.periodStart ? ` (${p.periodStart} – ${p.periodEnd})` : ''}`,
        amount: p.amount || 0,
        reference: p.reference || null,
        gymId: p.gymId
      });
    }

    entries.sort((a, b) => +new Date(b.date) - +new Date(a.date));
    return entries;
  }

  return { computeGymUsageSummaries, gymVisitDetails, buildPeriods, periodDistribution, bookKeeping };
}
