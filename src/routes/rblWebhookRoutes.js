const express = require('express');
const router = express.Router();
const prisma = require('../config/prismaClient');
const rbl = require('../services/rblPaymentService');
const { processRequery } = require('../services/rblPayoutService');

// Ignore repeat alerts for the same payout within this window (each one costs a bank status enquiry).
const MIN_REQUERY_GAP_MS = 30 * 1000;
const MAX_BODY_LOG = 20000;

const rawBody = express.text({ type: ['application/xml', 'text/xml', 'text/plain'], limit: '100kb' });

// Pull the first matching tag (XML) or key (JSON/form) from whatever RBL sends.
const pickId = (body, names) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body || {});
    for (const name of names) {
        const xml = text.match(new RegExp(`<${name}>\\s*([^<\\s]+)\\s*</${name}>`, 'i'));
        if (xml) return xml[1];
        const json = text.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`, 'i'));
        if (json) return json[1];
    }
    return null;
};

// RBL UPI payout alert. The payload is only a hint: the payout status is always
// confirmed with the bank's status enquiry, never taken from this request.
router.post('/upi', rawBody, async (req, res) => {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    const txnId = pickId(req.body, ['orgtxnid', 'txnid', 'txnId']);
    const refId = pickId(req.body, ['refid', 'refId']);

    let withdrawal = null;
    try {
        if (txnId || refId) {
            withdrawal = await prisma.withdrawal.findFirst({
                where: { OR: [txnId && { rblTxnId: txnId }, refId && { rblRefId: refId }].filter(Boolean) },
                select: { id: true, status: true, lastRequeryAt: true }
            });
        }
    } catch (err) {
        console.error('[RBL-WEBHOOK] Lookup failed:', err.message);
    }

    await rbl._logApi({
        withdrawalId: withdrawal?.id,
        api: 'webhook',
        txnId,
        requestBody: body.slice(0, MAX_BODY_LOG),
        httpStatus: 200,
        error: withdrawal ? null : `No matching payout (from ${req.ip})`
    });

    res.status(200).json({ status: 'received' });

    const recentlyChecked = withdrawal?.lastRequeryAt
        && Date.now() - new Date(withdrawal.lastRequeryAt).getTime() < MIN_REQUERY_GAP_MS;
    if (withdrawal && ['processing', 'on_hold'].includes(withdrawal.status) && !recentlyChecked) {
        processRequery(withdrawal.id).catch((err) =>
            console.error(`[RBL-WEBHOOK] Requery failed for withdrawal ${withdrawal.id}:`, err.message));
    }
});

module.exports = router;
