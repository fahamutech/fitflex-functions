# B2B collections (Phase 6)

How an organisation pays a FitFlex invoice, and how FitFlex chases one that is
late. It sits on top of Phase 5 (`B2B_FINANCE.md`): invoices, payments,
allocation and the two-person rules are unchanged.

Code: `src/services/b2b-collections-service.mjs`, routes in `functions/b2b.mjs`,
job in `functions/jobs.mjs`, migration `20261122090000-b2b-collections.cjs`,
tests `specs/b2b-collections.specs.mjs`.

## 1. Decisions this implements (product owner, 4 Oct 2026)

| # | Decision |
|---|---|
| P6-01 | No payment gateway. The organisation pays by bank or mobile money and sends an "I have paid" notice; FitFlex confirms it. |
| P6-02 | Reminders 3 days before the due day, on it, and 7, 14 and 30 days after. |
| P6-03 | Reminders only. Nothing is suspended automatically; staff can put an organisation on hold by hand. |
| P6-04 | No interest or late-payment charge. If one is ever agreed, staff raise a debit note. |

## 2. Payment details: `B2BPaymentInstruction`

One row (`id = 'default'`): bank name, account name, account number, branch,
SWIFT code, Lipa Namba and its name, free-text notes. Set by staff with
`b2b_billing_approve`. Shown to every organisation on its Billing page and
included in reminder emails. Until an account number or Lipa Namba is set, the
organisation is told to use the details on its agreement.

## 3. Payment notice: `B2BPaymentNotice`

The organisation says it has paid: amount, method, reference, the day paid,
optionally the invoices it is for, a note and a proof image.

```
submitted ──confirm──▶ confirmed   (a B2BPayment exists; paymentId is set)
    │────────reject───▶ rejected    (reason shown to the organisation)
    └────────withdraw─▶ withdrawn   (by the organisation, before a decision)
```

- **A notice settles nothing.** Only confirming it does.
- **One notice per reference.** The same reference by the same method is the
  same notice; sending it again returns the first, and a different amount under
  the same reference is refused (`payment_reference_in_use`). A rejected or
  withdrawn reference can be sent again.
- **Confirming records the payment** through `b2bFinanceService.recordPayment`,
  so every Phase 5 rule holds: the same reference is one payment, the receipt
  gets the next `FF-RCT` number, and the person who issued an invoice cannot
  settle it (that invoice is skipped and the money stays on the account as
  credit for a colleague to apply).
- **The statement wins.** Staff can confirm a different amount from the one the
  organisation gave.
- **Allocation.** Invoices the notice names are settled first, oldest due
  first; with none named, the oldest open invoices are. The rest is credit.
- Confirming twice records one payment. The organisation's owners and finance
  users are told in the app when a notice is confirmed or rejected.

## 4. Reminders: `B2BInvoiceReminder`

Job `b2bCollections`, daily at 09:00 EAT. For every issued invoice with money
owed and a due date (credit notes are never chased):

| Stage | When |
|---|---|
| `before3` | from 3 days before the due day up to the day before |
| `due` | the due day and the 6 days after |
| `plus7` | 7 to 13 days late |
| `plus14` | 14 to 29 days late |
| `plus30` | 30 days late or more |
| `manual` | sent by staff, any time |

Each scheduled stage is sent once per invoice (a unique index is the claim, so
reruns and overlapping runs send nothing twice). Stages do not pile up: an
invoice first seen 15 days late gets the 14-day reminder only. A paid or voided
invoice gets none.

A reminder goes to the organisation's active **owner** and **finance** users in
the app (inbox and push), and by email to the billing account's address when
the email sender is configured (`VERIFICATION_EMAIL_PROVIDER=mailgun`). The row
keeps who was told and what was owed at the time.

## 5. Hold

`B2BBillingAccount.onHold`, with a reason, who and when. Put on and lifted by
staff with `b2b_billing_approve`; never automatic. While on hold:

- no new sponsored-pass invoice is prepared (`organization_on_hold`), by staff
  or by the daily billing job;
- per-use benefits are not funded: the organisation's benefits are left out
  when a visit or session looks for a sponsor, so the member pays as if they
  had no benefit.

Passes already invoiced and paid for carry on. Changing the billing contact
does not lift a hold. The organisation sees the hold and its reason.

## 6. Permissions

| Who | Can |
|---|---|
| Organisation owner, admin, finance (`billing.pay`) | send and withdraw a payment notice |
| Organisation `billing.read` | see the payment details, the hold and the notices |
| Staff, any billing scope | see the collections queue and the payment details |
| Staff `b2b_payments` | confirm or reject a notice |
| Staff `b2b_billing` | send a reminder by hand |
| Staff `b2b_billing_approve` | put on or lift a hold; set the payment details |

## 7. API

Organisation:

- `GET  /b2b/organizations/:id/paying`
- `POST /b2b/organizations/:id/payment-notices`
- `POST /b2b/organizations/:id/payment-notices/:noticeId/withdraw`

Staff:

- `GET  /admin/b2b/collections`
- `GET|PUT /admin/b2b/payment-instructions`
- `GET  /admin/b2b/payment-notices?status=`
- `POST /admin/b2b/payment-notices/:noticeId/confirm` · `/reject`
- `POST /admin/b2b/invoices/:invoiceId/remind`
- `POST /admin/b2b/organizations/:id/billing-hold`

## 8. Known limitations

- **No payment gateway.** Nothing is collected online; `/webhooks/selcom` is
  still the unused subscription stub. A gateway would create the same
  `B2BPayment` a confirmed notice does.
- **Proof of payment is an image** uploaded through `/storage/upload`; PDFs are
  not accepted there.
- **Reminder emails are plain text** and go to one address, the billing
  contact. Reminder wording is English only.
- **Company seat bills** (the old Corporate billing) are not chased here; only
  B2B invoices are.
- **A draft pass invoice prepared before a hold** can still be issued by staff.
- **No late fee** is calculated, by decision.
