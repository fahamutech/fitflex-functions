// Admin invoice REST surface.
import '../src/bootstrap/init.mjs';
import { requireAuth, requireAcl } from '../src/auth/jwt.mjs';
import { invoiceService } from '../src/bootstrap/services.mjs';

const created = new Date().toISOString();

export const adminListInvoices = {
  created, method: 'get', path: '/admin/invoices',
  description: 'Admin: list all invoices with optional filters (?gymId=&status=&ownerId=).',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => {
    const { gymId, status, ownerId } = req.query || {};
    res.json(await invoiceService.list({ gymId, status, ownerId }));
  }
};

export const adminCreateInvoice = {
  created, method: 'post', path: '/admin/invoices',
  description: 'Admin: create an invoice for a gym unpaid balance.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => {
    const { gymId, amount, note, periodStart, periodEnd } = req.body || {};
    const result = await invoiceService.create({ gymId, amount, note, periodStart, periodEnd, actorId: req.user.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.invoice);
  }
};

export const adminUpdateInvoice = {
  created, method: 'put', path: '/admin/invoices/:id',
  description: 'Admin: update invoice — upload receipt, mark as paid, edit note.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => {
    const { receiptUrl, paymentReference, status, note } = req.body || {};
    const result = await invoiceService.update({ id: req.params.id, receiptUrl, paymentReference, status, note, actorId: req.user.sub });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.invoice);
  }
};

export const adminGetInvoice = {
  created, method: 'get', path: '/admin/invoices/:id',
  description: 'Admin: get a single invoice by ID.',
  onGuard: [requireAuth('admin'), requireAcl('payments')],
  onRequest: async (req, res) => {
    const result = await invoiceService.get(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.invoice);
  }
};
