const prisma = require('../config/prismaClient');
const { decrypt } = require('../utils/encryption');
const rbl = require('./rblPaymentService');

/*
 * RBL UPI payout engine.
 *
 * Wallet model: available = balance - lockedBalance.
 *   request  -> lockedBalance += amount               (done by the withdrawal request flow)
 *   success  -> balance -= amount, lockedBalance -= amount
 *   failure  -> lockedBalance -= amount               (funds become available again)
 *
 * Status machine:
 *   pending --initiatePayout--> processing
 *   processing --(bank SUCCESS via enquiry)--> completed
 *   processing --(bank FAILURE / request rejected)--> failed
 *   processing --(e4259 / not found after retry / requery window exceeded)--> on_hold
 *   on_hold --(manual requery with final bank status | admin manual resolution)--> completed | failed
 *   pending --(admin manual resolution)--> completed | failed
 *
 * A payout whose outcome at the bank is unknown is NEVER failed automatically:
 * it stays 'processing' (re-queried) or goes 'on_hold' for manual reconciliation.
 */

const LOG_PREFIX = '[RBL-PAYOUT]';
const OPEN_STATUSES = ['pending', 'processing', 'on_hold'];
const ENQUIRY_FAILURE_RETRY_MS = 5 * 60 * 1000;
const NOT_FOUND_LIMIT = 3;
const BANK_REJECTED_PREFIX = 'BANK_REJECTED:';
const REQUERY_BATCH_SIZE = 50;
const WORKER_INTERVAL_MS = 60 * 1000;

const envNumber = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return fallback;
    }
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : fallback;
};

const firstStatusCheckMs = () => envNumber('RBL_FIRST_STATUS_CHECK_SEC', 20) * 1000;
// RBL guidelines: pending (IN PROGRESS) -> checks at ~30 s and ~60 s, then every 3 hours.
// Timeout / HTTP error -> checks at ~30 s and ~60 s; if still 'not found', a 3rd check after 20 min,
// then re-attempt with the same TxnID/RefID.
const shortRecheckMs = () => envNumber('RBL_SHORT_RECHECK_SEC', 30) * 1000;
const inProgressIntervalMs = () => envNumber('RBL_IN_PROGRESS_INTERVAL_MIN', 180) * 60 * 1000;
const notFoundThirdCheckMs = () => envNumber('RBL_NOT_FOUND_THIRD_CHECK_MIN', 20) * 60 * 1000;
const maxRequeryDays = () => envNumber('RBL_MAX_REQUERY_DAYS', 7);
const reconHour = () => envNumber('RBL_RECON_HOUR', 2);
const maxTxnAmount = () => envNumber('RBL_MAX_TXN_AMOUNT', null);

const inMs = (ms) => new Date(Date.now() + ms);
const toAmount = (value) => Number(Number(value || 0).toFixed(2));

const log = (...args) => console.log(LOG_PREFIX, ...args);
const warn = (...args) => console.warn(LOG_PREFIX, ...args);
const logError = (...args) => console.error(LOG_PREFIX, ...args);

const WITHDRAWAL_INCLUDE = {
    PayoutMethod: true,
    Wallet: { include: { User: true } }
};

const loadWithdrawal = (withdrawalId) => prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
    include: WITHDRAWAL_INCLUDE
});

const updateWithdrawal = (withdrawalId, data) => prisma.withdrawal.update({
    where: { id: withdrawalId },
    data,
    include: WITHDRAWAL_INCLUDE
});

const safeDecryptVpa = (withdrawal) => {
    try {
        return withdrawal?.PayoutMethod?.value ? decrypt(withdrawal.PayoutMethod.value) : null;
    } catch (error) {
        warn(`Could not decrypt payout method for withdrawal ${withdrawal?.id}:`, error.message);
        return null;
    }
};

const payoutNote = (withdrawalId) => `Cashback payout ${String(withdrawalId).slice(0, 8)}`;

const httpError = (message, statusCode = 400) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.status = statusCode;
    return error;
};

const resolvePayeeName = async (withdrawal, vpa) => {
    const fallback = withdrawal?.Wallet?.User?.name || 'Customer';
    try {
        const result = await rbl.validateVPA(vpa, { withdrawalId: withdrawal.id });
        return result?.verifiedName || fallback;
    } catch (error) {
        warn(`validateVPA failed while rebuilding payee name for ${withdrawal.id}:`, error.message);
        return fallback;
    }
};

// ---------------------------------------------------------------------------
// Final money movement (idempotent)
// ---------------------------------------------------------------------------

const finalizeCompleted = async (withdrawalId, { referenceId, adminNote } = {}) => {
    const outcome = await prisma.$transaction(async (tx) => {
        const withdrawal = await tx.withdrawal.findUnique({
            where: { id: withdrawalId },
            include: { PayoutMethod: true }
        });
        if (!withdrawal) {
            throw httpError('Withdrawal not found', 404);
        }

        const finalReference = referenceId || withdrawal.referenceId || withdrawal.rblTxnId || withdrawal.id;
        const data = {
            status: 'completed',
            referenceId: finalReference,
            nextRequeryAt: null,
            holdReason: null
        };
        if (adminNote !== undefined) data.adminNote = adminNote;

        const claimed = await tx.withdrawal.updateMany({
            where: { id: withdrawalId, status: { in: OPEN_STATUSES } },
            data
        });
        if (claimed.count === 0) {
            return { changed: false };
        }

        const amount = toAmount(withdrawal.amount);
        const wallet = await tx.wallet.findUnique({ where: { id: withdrawal.walletId } });
        const locked = toAmount(wallet?.lockedBalance);
        let unlockAmount = amount;
        if (locked < amount) {
            unlockAmount = Math.max(0, locked);
            warn(`Wallet ${withdrawal.walletId} lockedBalance ${locked} < payout ${amount} for withdrawal ${withdrawalId}; unlocking only ${unlockAmount}`);
        }
        if (toAmount(wallet?.balance) < amount) {
            warn(`Wallet ${withdrawal.walletId} balance ${toAmount(wallet?.balance)} < payout ${amount} for withdrawal ${withdrawalId}`);
        }

        await tx.wallet.update({
            where: { id: withdrawal.walletId },
            data: {
                balance: { decrement: amount },
                lockedBalance: { decrement: unlockAmount }
            }
        });

        const vpa = safeDecryptVpa(withdrawal) || 'UPI';

        await tx.transaction.create({
            data: {
                walletId: withdrawal.walletId,
                type: 'debit',
                amount,
                category: 'withdrawal',
                status: 'success',
                description: `UPI Payout to ${vpa}`,
                referenceId: finalReference
            }
        });

        if (wallet?.userId) {
            await tx.notification.create({
                data: {
                    userId: wallet.userId,
                    title: 'Payout Successful',
                    message: `₹${amount} has been sent to your UPI: ${vpa}`,
                    type: 'payout-success',
                    metadata: {
                        withdrawalId,
                        amount,
                        upi: vpa,
                        referenceId: finalReference
                    }
                }
            });
        }

        return { changed: true, amount };
    });

    if (outcome.changed) {
        log(`Withdrawal ${withdrawalId} COMPLETED (amount ${outcome.amount})`);
    }
    return loadWithdrawal(withdrawalId);
};

const finalizeFailed = async (withdrawalId, { reason, adminNote, errorCode } = {}) => {
    const finalReason = reason || 'Payout failed';
    const outcome = await prisma.$transaction(async (tx) => {
        const withdrawal = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
        if (!withdrawal) {
            throw httpError('Withdrawal not found', 404);
        }

        const data = {
            status: 'failed',
            rejectionReason: finalReason,
            nextRequeryAt: null
        };
        if (adminNote !== undefined) data.adminNote = adminNote;
        if (errorCode) data.rblErrorCode = String(errorCode);

        const claimed = await tx.withdrawal.updateMany({
            where: { id: withdrawalId, status: { in: OPEN_STATUSES } },
            data
        });
        if (claimed.count === 0) {
            return { changed: false };
        }

        const amount = toAmount(withdrawal.amount);
        const wallet = await tx.wallet.findUnique({ where: { id: withdrawal.walletId } });
        const locked = toAmount(wallet?.lockedBalance);
        let unlockAmount = amount;
        if (locked < amount) {
            unlockAmount = Math.max(0, locked);
            warn(`Wallet ${withdrawal.walletId} lockedBalance ${locked} < payout ${amount} for withdrawal ${withdrawalId}; releasing only ${unlockAmount}`);
        }

        if (unlockAmount > 0) {
            await tx.wallet.update({
                where: { id: withdrawal.walletId },
                data: { lockedBalance: { decrement: unlockAmount } }
            });
        }

        if (wallet?.userId) {
            await tx.notification.create({
                data: {
                    userId: wallet.userId,
                    title: 'Payout Failed',
                    message: `Payout of ₹${amount} failed. ${finalReason}. The amount is available in your wallet again.`,
                    type: 'payout-failed',
                    metadata: {
                        withdrawalId,
                        amount,
                        reason: finalReason
                    }
                }
            });
        }

        return { changed: true, amount };
    });

    if (outcome.changed) {
        log(`Withdrawal ${withdrawalId} FAILED (amount ${outcome.amount}): ${finalReason}`);
    }
    return loadWithdrawal(withdrawalId);
};

const putOnHold = async (withdrawal, holdReason, extra = {}) => {
    log(`Withdrawal ${withdrawal.id} ON HOLD: ${holdReason}`);
    const wasOnHold = withdrawal.status === 'on_hold';
    const updated = await updateWithdrawal(withdrawal.id, {
        ...extra,
        status: 'on_hold',
        holdReason,
        nextRequeryAt: null
    });

    if (!wasOnHold && updated?.Wallet?.userId) {
        try {
            await prisma.notification.create({
                data: {
                    userId: updated.Wallet.userId,
                    title: 'Payout Under Review',
                    message: `Your payout of ₹${toAmount(updated.amount)} is being verified with the bank. We will update you once it is confirmed.`,
                    type: 'payout-on-hold',
                    metadata: {
                        withdrawalId: updated.id,
                        amount: toAmount(updated.amount)
                    }
                }
            });
        } catch (error) {
            warn(`Could not create on-hold notification for ${withdrawal.id}:`, error.message);
        }
    }
    return updated;
};

// ---------------------------------------------------------------------------
// Disburse outcome handling (shared by first send and same-id resend)
// ---------------------------------------------------------------------------

const handleDisburseResult = async (withdrawal, result, { isResend = false } = {}) => {
    const outcome = result?.outcome || 'uncertain';
    const description = result?.description || result?.status || null;
    const label = isResend ? 'resend' : 'disburse';
    log(`Withdrawal ${withdrawal.id} ${label} outcome=${outcome} http=${result?.httpStatus ?? '-'} desc=${description ?? '-'}`);

    switch (outcome) {
        case 'success':
            return updateWithdrawal(withdrawal.id, {
                rblTxnStatus: 'INITIATED',
                holdReason: null
            });
        case 'validation_error': {
            // Input rejected before anything was sent to the bank.
            const reason = description || 'Payment request rejected by bank';
            return finalizeFailed(withdrawal.id, {
                reason,
                errorCode: description || 'VALIDATION_ERROR'
            });
        }
        case 'rejected':
            // The bank answered with an error, but it may still have logged the transaction
            // (e.g. ':e4472' was logged IN PROGRESS). Fail only after status enquiries find nothing.
            return updateWithdrawal(withdrawal.id, {
                rblErrorCode: description || 'REJECTED',
                holdReason: `${BANK_REJECTED_PREFIX} ${description || 'error'} - confirming with status enquiry before failing`
            });
        case 'already_posted':
            return putOnHold(
                withdrawal,
                'RBL e4259: same payee and amount already paid today - verify with RBL before any retry',
                { rblErrorCode: description || 'e4259' }
            );
        case 'duplicate':
            return updateWithdrawal(withdrawal.id, {
                holdReason: `RBL reported duplicate ids on ${label} - awaiting status enquiry`
            });
        case 'session_expired':
            return updateWithdrawal(withdrawal.id, {
                holdReason: `RBL session expired on ${label} - outcome unknown, awaiting status enquiry`
            });
        case 'uncertain':
        default:
            return updateWithdrawal(withdrawal.id, {
                holdReason: `Uncertain ${label} response (HTTP ${result?.httpStatus ?? 'n/a'}${description ? `: ${description}` : ''}) - awaiting status enquiry`
            });
    }
};

// ---------------------------------------------------------------------------
// Initiate
// ---------------------------------------------------------------------------

const initiatePayout = async (withdrawalId) => {
    const existing = await loadWithdrawal(withdrawalId);
    if (!existing) {
        throw httpError('Withdrawal not found', 404);
    }
    if (existing.status !== 'pending' || existing.rblTxnId) {
        return existing;
    }

    const claim = await prisma.withdrawal.updateMany({
        where: { id: withdrawalId, status: 'pending', rblTxnId: null },
        data: { status: 'processing' }
    });
    if (claim.count === 0) {
        return loadWithdrawal(withdrawalId);
    }

    const withdrawal = await loadWithdrawal(withdrawalId);
    const amount = toAmount(withdrawal.amount);

    const limit = maxTxnAmount();
    if (limit !== null && amount > limit) {
        return finalizeFailed(withdrawalId, { reason: 'Amount exceeds per-transaction limit' });
    }

    if (withdrawal.PayoutMethod?.type !== 'upi') {
        return finalizeFailed(withdrawalId, { reason: 'Unsupported payout method' });
    }

    const vpa = safeDecryptVpa(withdrawal);
    if (!vpa) {
        return finalizeFailed(withdrawalId, { reason: 'Invalid UPI ID' });
    }

    // Pre-send stage: nothing has been sent to the bank yet, so failing here is safe.
    let name;
    let txnId;
    let refId;
    let orgTxnId;
    let prepared;
    try {
        const validation = await rbl.validateVPA(vpa, { withdrawalId });
        if (!validation?.isValid) {
            return finalizeFailed(withdrawalId, { reason: 'Invalid UPI ID' });
        }
        name = validation.verifiedName || withdrawal.Wallet?.User?.name || 'Customer';

        txnId = await rbl.getTransactionId({ withdrawalId });
        if (!txnId) {
            throw new Error('Empty transaction id from RBL');
        }
        refId = rbl.generateRefId();
        orgTxnId = rbl.generateRefId();

        const now = new Date();
        prepared = await updateWithdrawal(withdrawalId, {
            rblTxnId: txnId,
            rblRefId: refId,
            rblOrgTxnId: orgTxnId,
            initiatedAt: now,
            nextRequeryAt: new Date(now.getTime() + firstStatusCheckMs()),
            rblTxnStatus: null,
            rblErrorCode: null,
            holdReason: null
        });
    } catch (error) {
        logError(`Pre-send failure for withdrawal ${withdrawalId}:`, error.message);
        return finalizeFailed(withdrawalId, { reason: 'Payment gateway unavailable, please try again' });
    }

    log(`Disbursing withdrawal ${withdrawalId} txnId=${txnId} refId=${refId} amount=${amount}`);
    let result;
    try {
        result = await rbl.disburse({
            withdrawalId,
            txnId,
            refId,
            orgTxnId,
            vpa,
            name,
            amount,
            note: payoutNote(withdrawalId)
        });
    } catch (error) {
        // Contract says disburse never throws; if it does, the outcome is unknown.
        logError(`disburse threw for withdrawal ${withdrawalId}:`, error.message);
        result = { outcome: 'uncertain', description: error.message };
    }

    return handleDisburseResult(prepared, result);
};

// ---------------------------------------------------------------------------
// Status enquiry
// ---------------------------------------------------------------------------

const failureReasonFrom = (enquiry) => {
    const parts = [];
    if (enquiry?.txnErrorCode) parts.push(`error ${enquiry.txnErrorCode}`);
    if (enquiry?.payeeRespCode) parts.push(`payee response ${enquiry.payeeRespCode}`);
    return parts.length ? `Bank reported failure (${parts.join(', ')})` : 'Bank reported failure';
};

const resendSameIds = async (withdrawal) => {
    // Atomically mark the resend so two concurrent requeries can never both resend.
    const claim = await prisma.withdrawal.updateMany({
        where: { id: withdrawal.id, retriedSameIds: false, status: 'processing' },
        data: {
            retriedSameIds: true,
            notFoundCount: 0,
            nextRequeryAt: inMs(firstStatusCheckMs())
        }
    });
    if (claim.count === 0) {
        return loadWithdrawal(withdrawal.id);
    }

    const vpa = safeDecryptVpa(withdrawal);
    if (!vpa) {
        return putOnHold(withdrawal, 'Cannot decrypt UPI ID for same-id resend - verify with RBL');
    }
    const name = await resolvePayeeName(withdrawal, vpa);

    log(`Re-sending withdrawal ${withdrawal.id} with SAME ids txnId=${withdrawal.rblTxnId} refId=${withdrawal.rblRefId}`);
    let result;
    try {
        result = await rbl.disburse({
            withdrawalId: withdrawal.id,
            txnId: withdrawal.rblTxnId,
            refId: withdrawal.rblRefId,
            orgTxnId: withdrawal.rblOrgTxnId,
            vpa,
            name,
            amount: toAmount(withdrawal.amount),
            note: payoutNote(withdrawal.id)
        });
    } catch (error) {
        logError(`resend threw for withdrawal ${withdrawal.id}:`, error.message);
        result = { outcome: 'uncertain', description: error.message };
    }

    const fresh = await loadWithdrawal(withdrawal.id);
    return handleDisburseResult(fresh, result, { isResend: true });
};

const processRequery = async (withdrawalId) => {
    const withdrawal = await loadWithdrawal(withdrawalId);
    if (!withdrawal) {
        throw httpError('Withdrawal not found', 404);
    }
    if (!withdrawal.rblTxnId || !['processing', 'on_hold'].includes(withdrawal.status)) {
        return withdrawal;
    }

    const isProcessing = withdrawal.status === 'processing';

    if (withdrawal.initiatedAt) {
        const ageMs = Date.now() - new Date(withdrawal.initiatedAt).getTime();
        if (ageMs > maxRequeryDays() * 24 * 60 * 60 * 1000) {
            return putOnHold(withdrawal, 'Requery window exceeded - reconcile with bank statement / RBL support');
        }
    }

    const enquiry = await rbl.searchTransaction({ withdrawalId, id: withdrawal.rblTxnId, flag: 0 });
    const now = new Date();
    const base = {
        lastRequeryAt: now,
        requeryCount: { increment: 1 }
    };

    if (!enquiry || !enquiry.ok || !enquiry.txnStatus) {
        warn(`Enquiry failed for withdrawal ${withdrawalId}:`, enquiry?.error || `HTTP ${enquiry?.httpStatus ?? 'n/a'}`);
        return updateWithdrawal(withdrawalId, {
            ...base,
            ...(isProcessing ? { nextRequeryAt: new Date(now.getTime() + ENQUIRY_FAILURE_RETRY_MS) } : {})
        });
    }

    const txnStatus = String(enquiry.txnStatus).toUpperCase();
    log(`Enquiry withdrawal ${withdrawalId} txnId=${withdrawal.rblTxnId} -> ${txnStatus}`);

    const enquiryFields = {
        ...base,
        rblTxnStatus: txnStatus,
        rblCustRef: enquiry.custRef ?? undefined,
        rblErrorCode: enquiry.txnErrorCode ?? undefined,
        rblPayeeRespCode: enquiry.payeeRespCode ?? undefined
    };

    if (txnStatus === 'SUCCESS') {
        await updateWithdrawal(withdrawalId, enquiryFields);
        return finalizeCompleted(withdrawalId, { referenceId: enquiry.custRef || withdrawal.rblTxnId });
    }

    if (txnStatus === 'FAILURE') {
        await updateWithdrawal(withdrawalId, enquiryFields);
        return finalizeFailed(withdrawalId, {
            reason: failureReasonFrom(enquiry),
            errorCode: enquiry.txnErrorCode || enquiry.payeeRespCode || undefined
        });
    }

    // Non-final statuses. On-hold rows (manual requery) only record the enquiry;
    // they are never automatically re-sent or re-scheduled.
    if (!isProcessing) {
        return updateWithdrawal(withdrawalId, enquiryFields);
    }

    if (txnStatus === 'NOT_FOUND') {
        const notFoundCount = (withdrawal.notFoundCount || 0) + 1;
        if (notFoundCount < NOT_FOUND_LIMIT) {
            return updateWithdrawal(withdrawalId, {
                ...enquiryFields,
                notFoundCount,
                nextRequeryAt: new Date(now.getTime() + (notFoundCount === 1 ? shortRecheckMs() : notFoundThirdCheckMs()))
            });
        }

        // The bank rejected the request and has no record of it: safe to fail, no resend.
        if (withdrawal.holdReason && withdrawal.holdReason.startsWith(BANK_REJECTED_PREFIX)) {
            await updateWithdrawal(withdrawalId, { ...enquiryFields, notFoundCount });
            return finalizeFailed(withdrawalId, {
                reason: withdrawal.rblErrorCode || 'Payment request rejected by bank',
                errorCode: withdrawal.rblErrorCode || 'REJECTED'
            });
        }

        if (!withdrawal.retriedSameIds) {
            const updated = await updateWithdrawal(withdrawalId, { ...enquiryFields, notFoundCount });
            return resendSameIds(updated);
        }

        return putOnHold(
            withdrawal,
            'Transaction not found at bank after retry - verify with RBL',
            { ...enquiryFields, notFoundCount }
        );
    }

    // IN PROGRESS (or any other unknown, non-final status)
    const stillRejectedMarker = withdrawal.holdReason && withdrawal.holdReason.startsWith(BANK_REJECTED_PREFIX);
    return updateWithdrawal(withdrawalId, {
        ...enquiryFields,
        // The bank has a record after all, so it must never be failed on a later "not found".
        ...(stillRejectedMarker ? { holdReason: `Bank returned "${withdrawal.rblErrorCode}" but logged the transaction as ${txnStatus}` } : {}),
        nextRequeryAt: new Date(now.getTime() + ((withdrawal.requeryCount || 0) < 1 ? shortRecheckMs() : inProgressIntervalMs()))
    });
};

// ---------------------------------------------------------------------------
// Admin manual resolution
// ---------------------------------------------------------------------------

const finalizeManually = async (withdrawalId, status, { referenceId, adminNote, reason } = {}) => {
    if (!['completed', 'failed'].includes(status)) {
        throw httpError("Status must be 'completed' or 'failed'", 400);
    }

    const withdrawal = await loadWithdrawal(withdrawalId);
    if (!withdrawal) {
        throw httpError('Withdrawal not found', 404);
    }
    if (!['pending', 'on_hold'].includes(withdrawal.status)) {
        throw httpError(`Withdrawal cannot be resolved manually from status '${withdrawal.status}'`, 400);
    }

    if (status === 'failed') {
        const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
        if (withdrawal.rblTxnId && !trimmedReason) {
            throw httpError('A reason is required to fail a payout that was sent to the bank', 400);
        }
        log(`Manual FAIL of withdrawal ${withdrawalId} (from ${withdrawal.status})`);
        return finalizeFailed(withdrawalId, {
            reason: trimmedReason || 'Rejected by admin',
            adminNote
        });
    }

    log(`Manual COMPLETE of withdrawal ${withdrawalId} (from ${withdrawal.status})`);
    return finalizeCompleted(withdrawalId, { referenceId, adminNote });
};

// ---------------------------------------------------------------------------
// Background cycles
// ---------------------------------------------------------------------------

let running = false;
let reconRunning = false;

const runRequeryCycle = async () => {
    if (running) {
        return { skipped: true };
    }
    running = true;
    let processed = 0;
    let errors = 0;
    try {
        const due = await prisma.withdrawal.findMany({
            where: {
                status: 'processing',
                rblTxnId: { not: null },
                nextRequeryAt: { lte: new Date() }
            },
            orderBy: { nextRequeryAt: 'asc' },
            take: REQUERY_BATCH_SIZE,
            select: { id: true }
        });

        for (const item of due) {
            try {
                await processRequery(item.id);
                processed += 1;
            } catch (error) {
                errors += 1;
                logError(`Requery failed for withdrawal ${item.id}:`, error.message);
            }
        }

        if (due.length) {
            log(`Requery cycle: ${processed} processed, ${errors} errors (of ${due.length} due)`);
        }
        return { processed, errors };
    } finally {
        running = false;
    }
};

const runDailyReconciliation = async () => {
    if (reconRunning) {
        return { skipped: true };
    }
    reconRunning = true;
    const summary = { checked: 0, resolved: 0, mismatches: [] };
    try {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const rows = await prisma.withdrawal.findMany({
            where: {
                rblTxnId: { not: null },
                initiatedAt: { gte: since }
            },
            orderBy: { initiatedAt: 'asc' }
        });

        for (const row of rows) {
            try {
                const enquiry = await rbl.searchTransaction({ withdrawalId: row.id, id: row.rblTxnId, flag: 0 });
                summary.checked += 1;
                if (!enquiry?.ok || !enquiry.txnStatus) {
                    continue;
                }
                const bankStatus = String(enquiry.txnStatus).toUpperCase();

                if (['processing', 'on_hold'].includes(row.status)) {
                    if (bankStatus === 'SUCCESS') {
                        await prisma.withdrawal.update({
                            where: { id: row.id },
                            data: {
                                rblTxnStatus: bankStatus,
                                rblCustRef: enquiry.custRef ?? undefined,
                                lastRequeryAt: new Date()
                            }
                        });
                        await finalizeCompleted(row.id, { referenceId: enquiry.custRef || row.rblTxnId });
                        summary.resolved += 1;
                    } else if (bankStatus === 'FAILURE') {
                        await prisma.withdrawal.update({
                            where: { id: row.id },
                            data: {
                                rblTxnStatus: bankStatus,
                                rblErrorCode: enquiry.txnErrorCode ?? undefined,
                                rblPayeeRespCode: enquiry.payeeRespCode ?? undefined,
                                lastRequeryAt: new Date()
                            }
                        });
                        await finalizeFailed(row.id, {
                            reason: failureReasonFrom(enquiry),
                            errorCode: enquiry.txnErrorCode || enquiry.payeeRespCode || undefined
                        });
                        summary.resolved += 1;
                    }
                    continue;
                }

                const mismatch =
                    (row.status === 'completed' && bankStatus === 'FAILURE') ||
                    (row.status === 'failed' && bankStatus === 'SUCCESS');
                if (mismatch) {
                    const description = `RECON MISMATCH: local status '${row.status}' but bank status '${bankStatus}' (txnId ${row.rblTxnId}) - manual review required, no money moved`;
                    console.error(`${LOG_PREFIX} RECON MISMATCH withdrawal=${row.id} local=${row.status} bank=${bankStatus} txnId=${row.rblTxnId} amount=${toAmount(row.amount)}`);
                    await prisma.withdrawal.update({
                        where: { id: row.id },
                        data: { holdReason: description }
                    });
                    summary.mismatches.push({
                        withdrawalId: row.id,
                        rblTxnId: row.rblTxnId,
                        localStatus: row.status,
                        bankStatus,
                        amount: toAmount(row.amount)
                    });
                }
            } catch (error) {
                logError(`Reconciliation failed for withdrawal ${row.id}:`, error.message);
            }
        }

        log('Daily reconciliation summary:', JSON.stringify(summary));
        return summary;
    } finally {
        reconRunning = false;
    }
};

let lastReconDate = null;

const localDateKey = (date) => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

const startRblPayoutWorker = () => {
    if (process.env.RBL_PAYOUT_WORKER_ENABLED === 'false') {
        log('Payout worker disabled (RBL_PAYOUT_WORKER_ENABLED=false)');
        return null;
    }
    // pm2 cluster mode runs one process per CPU; only the first instance runs the worker.
    if (process.env.NODE_APP_INSTANCE !== undefined && process.env.NODE_APP_INSTANCE !== '0') {
        return null;
    }

    const tick = async () => {
        try {
            await runRequeryCycle();
        } catch (error) {
            logError('Requery cycle error:', error.message);
        }

        try {
            const now = new Date();
            const today = localDateKey(now);
            if (now.getHours() >= reconHour() && lastReconDate !== today) {
                lastReconDate = today;
                runDailyReconciliation().catch((error) => {
                    logError('Daily reconciliation error:', error.message);
                });
            }
        } catch (error) {
            logError('Reconciliation scheduling error:', error.message);
        }
    };

    const handle = setInterval(() => {
        tick().catch((error) => logError('Worker tick error:', error.message));
    }, WORKER_INTERVAL_MS);
    if (typeof handle.unref === 'function') {
        handle.unref();
    }

    log(`Payout worker started (every ${WORKER_INTERVAL_MS / 1000}s, reconciliation after ${reconHour()}:00)`);
    return handle;
};

module.exports = {
    initiatePayout,
    processRequery,
    finalizeCompleted,
    finalizeFailed,
    finalizeManually,
    runRequeryCycle,
    runDailyReconciliation,
    startRblPayoutWorker
};
