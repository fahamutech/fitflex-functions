// Campaign names were saved as the raw message title, so a campaign from a
// template showed in lists, history and results as
// "{{discount}} off: {{offer_name}}". Members always got the filled-in
// text; only the label was wrong. New campaigns now store a readable name
// (labelText in src/shared/communications.mjs); this rewrites the existing
// ones the same way: the sender's values filled in, per-member ones left out.

const VARIABLE_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;
const NAME_MAX = 80;

function label(text, content, gymName) {
  const known = {
    gym_name: gymName || 'FitFlex',
    amount: content?.amountTzs != null ? `TZS ${Math.round(content.amountTzs).toLocaleString('en-US')}` : '…',
    discount: content?.discount || '…',
    offer_name: content?.offerName || '…',
  };
  const out = String(text || '')
    .replace(VARIABLE_RE, (_, name) => known[name] ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([,.!?:;])/g, '$1')
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '')
    .trim();
  return (out || 'Untitled message').slice(0, NAME_MAX);
}

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('CommunicationCampaign'))) return;
  const rows = await knex('CommunicationCampaign as c').leftJoin('Gym as g', 'g.id', 'c.gymId')
    .where('c.name', 'like', '%{{%').select('c.id', 'c.name', 'c.content', 'c.senderType', 'g.name as gymName');
  for (const r of rows) {
    const content = typeof r.content === 'string' ? JSON.parse(r.content) : r.content;
    const name = label(r.name, content, r.senderType === 'gym' ? r.gymName : 'FitFlex');
    if (name !== r.name) await knex('CommunicationCampaign').where({ id: r.id }).update({ name });
  }
};

// The raw titles are still in each campaign's content; nothing to undo.
exports.down = async function down() {};
