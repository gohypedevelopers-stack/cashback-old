const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const getQrBaseUrl = () => {
    const base =
        process.env.QR_BASE_URL ||
        process.env.FRONTEND_URL ||
        process.env.PUBLIC_APP_URL ||
        'https://assuredrewards.in';
    return String(base).replace(/\/$/, '');
};

const toRoman = (num) => {
    return String(Math.max(1, Math.floor(num)));
};

const DEFAULT_QRS_PER_GRID_PAGE = 25;
const ALLOWED_QR_ECC_LEVELS = new Set(['L', 'M', 'Q', 'H']);
const QR_ERROR_CORRECTION_LEVEL = (() => {
    const configured = String(process.env.QR_PDF_ECC_LEVEL || 'L').trim().toUpperCase();
    return ALLOWED_QR_ECC_LEVELS.has(configured) ? configured : 'L';
})();
const QR_MARGIN = (() => {
    const parsed = Number.parseInt(process.env.QR_PDF_MARGIN || '0', 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed;
})();
const QR_RENDER_BATCH_SIZE = (() => {
    const parsed = Number.parseInt(process.env.QR_PDF_RENDER_BATCH_SIZE || '50', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 50;
    return Math.min(parsed, 250);
})();
const LOGO_FETCH_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(process.env.QR_PDF_LOGO_TIMEOUT_MS || '1200', 10);
    if (!Number.isFinite(parsed) || parsed < 100) return 1200;
    return parsed;
})();
const LOGO_CACHE_SUCCESS_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.QR_PDF_LOGO_CACHE_TTL_MS || '1800000', 10);
    if (!Number.isFinite(parsed) || parsed < 1000) return 1800000;
    return parsed;
})();
const LOGO_CACHE_FAILURE_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.QR_PDF_LOGO_FAIL_CACHE_TTL_MS || '300000', 10);
    if (!Number.isFinite(parsed) || parsed < 1000) return 300000;
    return parsed;
})();
const LOGO_CACHE_MAX_ITEMS = (() => {
    const parsed = Number.parseInt(process.env.QR_PDF_LOGO_CACHE_MAX_ITEMS || '100', 10);
    if (!Number.isFinite(parsed) || parsed < 10) return 100;
    return parsed;
})();
const logoCache = new Map();

const getApiBaseUrl = () => {
    const port = process.env.PORT || 5000;
    const base =
        process.env.BACKEND_URL ||
        process.env.API_BASE_URL ||
        process.env.PUBLIC_API_URL ||
        `http://localhost:${port}`;
    return String(base).replace(/\/$/, '');
};

const getCachedLogoValue = (key) => {
    const cached = logoCache.get(key);
    if (!cached) return { hit: false, value: null };

    if (cached.expiresAt <= Date.now()) {
        logoCache.delete(key);
        return { hit: false, value: null };
    }

    return { hit: true, value: cached.value };
};

const setCachedLogoValue = (key, value, isFailure = false) => {
    if (!key) return;

    logoCache.set(key, {
        value,
        expiresAt: Date.now() + (isFailure ? LOGO_CACHE_FAILURE_TTL_MS : LOGO_CACHE_SUCCESS_TTL_MS)
    });

    while (logoCache.size > LOGO_CACHE_MAX_ITEMS) {
        const oldestKey = logoCache.keys().next().value;
        if (!oldestKey) break;
        logoCache.delete(oldestKey);
    }
};

const normalizeUploadRelativePath = (value) => {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized.toLowerCase().startsWith('uploads/')) return null;

    const filePart = normalized.slice('uploads/'.length);
    if (!filePart || filePart.includes('..')) return null;

    return filePart;
};

const getLocalUploadLogoBuffer = (logoValue) => {
    const uploadFile = normalizeUploadRelativePath(logoValue);
    if (!uploadFile) return null;

    const uploadsRoot = path.resolve(__dirname, '../../uploads');
    const absolutePath = path.resolve(uploadsRoot, uploadFile);

    if (!absolutePath.toLowerCase().startsWith(uploadsRoot.toLowerCase())) {
        return null;
    }

    if (!fs.existsSync(absolutePath)) {
        return null;
    }

    return fs.readFileSync(absolutePath);
};

const fetchRemoteLogo = async (logoUrl) => {
    const response = await axios.get(logoUrl, {
        responseType: 'arraybuffer',
        timeout: LOGO_FETCH_TIMEOUT_MS,
        validateStatus: (status) => status >= 200 && status < 300
    });
    return Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
};

const getBrandLogoBuffer = async (brandLogoUrl) => {
    if (typeof brandLogoUrl !== 'string') return null;
    const raw = brandLogoUrl.trim();
    if (!raw) return null;
    const cachedRaw = getCachedLogoValue(raw);
    if (cachedRaw.hit) return cachedRaw.value;

    if (raw.startsWith('data:image/')) {
        const base64 = raw.split(',')[1];
        if (!base64) {
            setCachedLogoValue(raw, null, true);
            return null;
        }
        const decoded = Buffer.from(base64, 'base64');
        setCachedLogoValue(raw, decoded);
        return decoded;
    }

    const uploadRelativePath = normalizeUploadRelativePath(raw);
    if (uploadRelativePath) {
        const localLogo = getLocalUploadLogoBuffer(raw);
        if (localLogo) {
            setCachedLogoValue(raw, localLogo);
            return localLogo;
        }
        setCachedLogoValue(raw, null, true);
        return null;
    }

    let resolved = raw;
    try {
        if (!/^https?:\/\//i.test(resolved)) {
            resolved = new URL(raw, `${getApiBaseUrl()}/`).toString();
        }

        if (/^https?:\/\//i.test(resolved)) {
            const cachedResolved = getCachedLogoValue(resolved);
            if (cachedResolved.hit) {
                setCachedLogoValue(raw, cachedResolved.value, cachedResolved.value === null);
                return cachedResolved.value;
            }

            const remoteLogo = await fetchRemoteLogo(resolved);
            setCachedLogoValue(resolved, remoteLogo);
            setCachedLogoValue(raw, remoteLogo);
            return remoteLogo;
        }
    } catch (err) {
        console.error('Failed to fetch brand logo for PDF:', err.message);
        setCachedLogoValue(raw, null, true);
        if (resolved && resolved !== raw) {
            setCachedLogoValue(resolved, null, true);
        }
        return null;
    }

    setCachedLogoValue(raw, null, true);
    return null;
};

const getVoucherDesignBuffer = (designUrl) => {
    if (!designUrl) return null;
    const uploadsRoot = path.resolve(__dirname, '../../uploads');
    // designUrl is expected to be like 'card_design_1.png'
    const absolutePath = path.resolve(uploadsRoot, designUrl);

    if (!absolutePath.toLowerCase().startsWith(uploadsRoot.toLowerCase())) {
        return null;
    }

    if (!fs.existsSync(absolutePath)) {
        console.warn('Voucher design file not found:', absolutePath);
        return null;
    }

    return fs.readFileSync(absolutePath);
};

const buildQrTarget = (uniqueHash) => `${getQrBaseUrl()}/redeem/${uniqueHash}`;
const isRedeemedQrStatus = (status) => String(status || '').toLowerCase() === 'redeemed';

const resolveSheetHeaderAmount = (sheetQrs = []) => {
    const pickPositive = (items) =>
        items
            .map((item) => Number(item?.cashbackAmount))
            .find((value) => Number.isFinite(value) && value > 0);

    const mutableAmount = pickPositive(sheetQrs.filter((item) => !isRedeemedQrStatus(item?.status)));
    if (Number.isFinite(mutableAmount)) return mutableAmount;

    const fallbackAmount = pickPositive(sheetQrs);
    return Number.isFinite(fallbackAmount) ? fallbackAmount : 0;
};

const renderQrBuffer = async (uniqueHash, width) => {
    return QRCode.toBuffer(buildQrTarget(uniqueHash), {
        type: 'png',
        width,
        margin: 0,
        errorCorrectionLevel: QR_ERROR_CORRECTION_LEVEL
    });
};

async function* renderQrBatchStream(qrItems, width, batchSize = QR_RENDER_BATCH_SIZE) {
    for (let index = 0; index < qrItems.length; index += batchSize) {
        const batch = qrItems.slice(index, index + batchSize);
        const buffers = await Promise.all(batch.map((item) => renderQrBuffer(item.uniqueHash, width)));

        for (let offset = 0; offset < batch.length; offset += 1) {
            yield {
                qr: batch[offset],
                buffer: buffers[offset],
                index: index + offset
            };
        }
    }
}

const renderQrPageBuffers = async (qrItems, width) => {
    const rendered = [];
    for await (const item of renderQrBatchStream(qrItems, width)) {
        rendered.push(item.buffer);
    }
    return rendered;
};

const createPdfResultPromise = (doc, outputStream, chunks) => new Promise((resolve, reject) => {
    const handleError = (error) => reject(error);
    doc.on('error', handleError);

    if (outputStream) {
        outputStream.on('error', handleError);
        outputStream.on('finish', () => resolve(null));
        doc.pipe(outputStream);
        return;
    }

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
});

const reportProgress = async (onProgress, processedQrs) => {
    if (typeof onProgress !== 'function') return;
    await onProgress(processedQrs);
};

const drawPrepaidHeader = ({
    doc,
    brandLogoBuffer,
    brandName,
    campaignTitle,
    productName,
    orderId,
    totalQrs
}) => {
    let yPos = 30;

    doc.fontSize(24).font('Helvetica-Bold').fillColor('#10b981').text('Assured Rewards', {
        align: 'center'
    });
    doc.fillColor('black');
    yPos += 35;

    if (brandLogoBuffer) {
        const logoWidth = 60;
        doc.image(brandLogoBuffer, (doc.page.width - logoWidth) / 2, yPos, { width: logoWidth });
        yPos += 70;
    } else if (brandName) {
        doc.fontSize(18).font('Helvetica-Bold').text(brandName, { align: 'center' });
        yPos += 25;
    }

    if (brandLogoBuffer && brandName) {
        doc.fontSize(16).font('Helvetica-Bold').text(brandName, { align: 'center' });
        yPos += 20;
    }

    doc.fontSize(14).font('Helvetica-Bold').text('QR Code Sheet', 30, yPos, {
        width: doc.page.width - 60,
        align: 'center'
    });
    yPos += 20;

    doc.fontSize(10).font('Helvetica').text(`Campaign: ${campaignTitle}`, { align: 'center' });
    yPos += 15;

    doc.text(`Product: ${productName || 'N/A'}`, { align: 'center' });
    yPos += 15;

    doc.text(`Order ID: ${String(orderId || '').slice(-8)}`, { align: 'center' });
    yPos += 15;

    doc.text(`Total QR Codes: ${totalQrs}`, { align: 'center' });
    yPos += 30;

    return yPos;
};

const drawPostpaidHeader = ({
    doc,
    brandLogoBuffer,
    brandName,
    campaignTitle,
    productName,
    sheetQrs,
    globalSheetIdx,
    displayTotalSheets,
    logicalPageIdx,
    pagesPerLogicalSheet,
    batchLabel,
    qrRange,
    logicalQrsPerSheet,
    allocations
}) => {
    let yPos = 20;
    const sheetLetter = toRoman(globalSheetIdx + 1);

    const sheetCashback = resolveSheetHeaderAmount(sheetQrs);
    const hasAssuredRewards = sheetQrs.some(qr => qr?.cashbackAmount !== null && qr.cashbackAmount !== undefined);

    if (hasAssuredRewards) {
        doc.fontSize(16).font('Helvetica-Bold').fillColor('#059669');
        if (sheetCashback) {
            doc.text(`Rs. ${sheetCashback}`, 30, yPos, { align: 'left', continued: true });
            doc.text('Assured Rewards', 30, yPos, { align: 'center' });
        } else {
            doc.text('Assured Rewards', 30, yPos, { align: 'center' });
        }
    } else {
        doc.fontSize(16).font('Helvetica-Bold').fillColor('#059669');
        doc.text('Lucky Draw Rewards', 30, yPos, { align: 'center' });
    }
    yPos += 20;

    doc.fillColor('black');

    if (brandLogoBuffer) {
        const maxLogoWidth = 100;
        const maxLogoHeight = 35;
        try {
            doc.image(brandLogoBuffer, (doc.page.width - maxLogoWidth) / 2, yPos, {
                fit: [maxLogoWidth, maxLogoHeight],
                align: 'center'
            });
            yPos += maxLogoHeight + 10;
        } catch (e) {
            console.error('Failed to draw brand logo:', e);
            doc.fontSize(14).font('Helvetica-Bold').text(brandName, 30, yPos, { align: 'center' });
            yPos += 20;
        }
    } else if (brandName) {
        doc.fontSize(14).font('Helvetica-Bold').text(brandName, 30, yPos, {
            width: doc.page.width - 60,
            align: 'center'
        });
        yPos += 20;
    }

    let detectedBatch = null;
    const startQrNumForBatch = (globalSheetIdx * (logicalQrsPerSheet || 25)) + 1;
    let parsedAllocations = allocations;
    if (typeof allocations === 'string') {
        try { parsedAllocations = JSON.parse(allocations); } catch (e) {}
    }
    if (parsedAllocations && Array.isArray(parsedAllocations)) {
        const validBatches = parsedAllocations.filter(a => Number(a.cashbackAmount) > 0 || Number(a.totalBudget) > 0);
        let cursor = 1;
        for (let i = 0; i < validBatches.length; i++) {
            const qty = Number(validBatches[i].quantity || 0);
            const batchStart = cursor;
            const batchEnd = cursor + qty - 1;
            if (startQrNumForBatch >= batchStart && startQrNumForBatch <= batchEnd) {
                detectedBatch = `Batch ${i + 1}`;
                break;
            }
            cursor += qty;
        }
    }

    const effectiveBatchLabel = batchLabel || detectedBatch;
    if (effectiveBatchLabel) {
        doc.fontSize(14).font('Helvetica-Bold').text(effectiveBatchLabel, 30, yPos, {
            width: doc.page.width - 60,
            align: 'center'
        });
        yPos += 18;
    } else {
        doc.fontSize(14).font('Helvetica-Bold').text(`Sheet ${sheetLetter}`, 30, yPos, {
            width: doc.page.width - 60,
            align: 'center'
        });
        yPos += 18;
    }

    doc.fontSize(9).font('Helvetica').text(`Campaign: ${campaignTitle}`, 30, yPos, {
        width: doc.page.width - 60,
        align: 'center'
    });
    yPos += 13;

    doc.text(`Product: ${productName || 'N/A'}`, 30, yPos, {
        width: doc.page.width - 60,
        align: 'center'
    });
    yPos += 13;

    if (batchLabel && qrRange) {
        doc.text(`Range: ${qrRange}  |  ${sheetQrs.length} QR Codes`, 30, yPos, {
            width: doc.page.width - 60,
            align: 'center'
        });
    } else {
        const startQrNum = (globalSheetIdx * (logicalQrsPerSheet || 25)) + 1;
        const endQrNum = startQrNum + sheetQrs.length - 1;
        const sheetQrRange = endQrNum > startQrNum ? `QRs ${startQrNum}-${endQrNum}` : `QR ${startQrNum}`;
        doc.text(`Sheet ${globalSheetIdx + 1} of ${displayTotalSheets}  |  Range: ${sheetQrRange}  |  ${sheetQrs.length} QR Codes`, 30, yPos, {
            width: doc.page.width - 60,
            align: 'center'
        });
    }
    yPos += 30;

    if (pagesPerLogicalSheet > 1) {
        doc.fontSize(8).font('Helvetica').fillColor('#4b5563');
        doc.text(`Page ${logicalPageIdx + 1} of ${pagesPerLogicalSheet}`, 30, yPos, {
            width: doc.page.width - 60,
            align: 'center'
        });
        doc.fillColor('black');
        yPos += 12;
    }

    return { yPos, effectiveBatchLabel };
};

const drawPostpaidPageGrid = ({
    doc,
    pageQrs,
    pageBuffers,
    yPos,
    globalSheetIdx,
    pageStart,
    voucherDesignBuffer,
    batchLabel
}) => {
    const qrSize = 85;
    const labelHeight = 30;
    const cellWidth = (doc.page.width - 60) / 5;
    const cellHeight = qrSize + labelHeight + 6;
    const startX = 30;
    const SHEET_ID_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const idLetter = globalSheetIdx < SHEET_ID_LETTERS.length
        ? SHEET_ID_LETTERS[globalSheetIdx]
        : `${globalSheetIdx + 1}`;

    for (let i = 0; i < pageQrs.length; i += 1) {
        const qr = pageQrs[i];
        const col = i % 5;
        const row = Math.floor(i / 5);
        const currentX = startX + col * cellWidth;
        const currentY = yPos + row * cellHeight;
        const isRedeemed = isRedeemedQrStatus(qr?.status);
        const imageX = currentX + (cellWidth - qrSize) / 2;
        const imageY = currentY;

        doc.image(pageBuffers[i], imageX, imageY, {
            width: qrSize,
            height: qrSize
        });

        if (voucherDesignBuffer) {
            // If we have a design, we draw it as a card background
            // We'll adjust the QR size and position for the card
            const cardWidth = cellWidth - 10;
            const cardHeight = cellHeight - 5;
            const cardX = currentX + 5;
            const cardY = currentY;

            // Draw card background first
            doc.image(voucherDesignBuffer, cardX, cardY, { width: cardWidth, height: cardHeight });

            // Redraw QR on top, centered in the card
            const scaledQrSize = 45;
            doc.image(pageBuffers[i], cardX + (cardWidth - scaledQrSize) / 2, cardY + 10, {
                width: scaledQrSize,
                height: scaledQrSize
            });
        }

        if (isRedeemed) {
            const badgeWidth = 46;
            const badgeHeight = 11;
            const badgeX = imageX + 3;
            const badgeY = imageY + 3;
            doc.roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 2).fill('#FEF3C7');
            doc.roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 2)
                .lineWidth(0.4)
                .strokeColor('#F59E0B')
                .stroke();
            doc.fillColor('#B45309').fontSize(6).font('Helvetica-Bold');
            doc.text('CLAIMED', badgeX, badgeY + 2.5, {
                width: badgeWidth,
                align: 'center'
            });
            doc.fillColor('black');
        }

        const withinSheetIndex = pageStart + i + 1;
        const qrLabel = `${idLetter}${withinSheetIndex}`;
        let labelY = currentY + qrSize + 2;
        doc.fontSize(9).font('Helvetica-Bold');
        doc.text(qrLabel, currentX, labelY, {
            width: cellWidth,
            align: 'center'
        });



        const isRedeemedText = isRedeemed;
        if (isRedeemedText) {
            doc
                .fontSize(7)
                .font('Helvetica-Bold')
                .fillColor('#b45309');
            const redeemedText = qr?.cashbackAmount ? `(Redeemed - Rs. ${qr.cashbackAmount})` : `(Redeemed)`;
            doc.text(
                redeemedText,
                currentX,
                labelY + 10,
                {
                    width: cellWidth,
                    align: 'center'
                }
            );
            doc.fillColor('black');
        }
    }
};

const drawPrepaidPageGrid = ({
    doc,
    pageQrs,
    pageBuffers,
    startY,
    voucherDesignBuffer
}) => {
    const qrSize = 80;
    const labelHeight = 35;
    const cellWidth = 100;
    const cellHeight = qrSize + labelHeight + 10;
    const cols = 5;
    const startX = 30;

    let currentX = startX;
    let currentY = startY;
    let col = 0;

    for (let i = 0; i < pageQrs.length; i += 1) {
        const qr = pageQrs[i];

        if (voucherDesignBuffer) {
            const cardWidth = cellWidth - 10;
            const cardHeight = cellHeight - 10;
            const cardX = currentX + 5;
            const cardY = currentY;

            doc.image(voucherDesignBuffer, cardX, cardY, { width: cardWidth, height: cardHeight });

            const scaledQrSize = 40;
            doc.image(pageBuffers[i], cardX + (cardWidth - scaledQrSize) / 2, cardY + 12, {
                width: scaledQrSize,
                height: scaledQrSize
            });
        } else {
            doc.image(pageBuffers[i], currentX + (cellWidth - qrSize) / 2, currentY, {
                width: qrSize,
                height: qrSize
            });
        }

        const labelY = currentY + qrSize + 2;
        
        if (qr.status === 'redeemed') {
            // Red watermark over the generic QR code or card 
            const imgX = voucherDesignBuffer ? currentX + 5 + ((cellWidth - 10) - 40) / 2 : currentX + (cellWidth - qrSize) / 2;
            const imgY = voucherDesignBuffer ? currentY + 12 : currentY;
            const imgS = voucherDesignBuffer ? 40 : qrSize;

            doc.save();
            doc.fillColor('white').fillOpacity(0.85);
            doc.rect(imgX, imgY, imgS, imgS).fill();
            doc.fillColor('red').fillOpacity(1);
            doc.fontSize(imgS > 50 ? 12 : 8).font('Helvetica-Bold');
            doc.translate(imgX + imgS/2, imgY + imgS/2);
            doc.rotate(-45);
            doc.text("CLAIMED", -30, -5, { width: 60, align: 'center' });
            doc.restore();

            doc.fontSize(7).font('Helvetica-Bold').fillColor('red');
            const claimedText = qr?.cashbackAmount ? `- CLAIMED (Rs. ${qr.cashbackAmount})` : `- CLAIMED`;
            doc.text(`#${String(qr.uniqueHash || '').slice(-6)} ${claimedText}`, currentX, labelY, {
                width: cellWidth,
                align: 'center'
            });
        } else {
            doc.fontSize(7).font('Helvetica').fillColor('black');
            doc.text(`#${String(qr.uniqueHash || '').slice(-6)}`, currentX, labelY, {
                width: cellWidth,
                align: 'center'
            });
        }

        // Removing the amount label from the bottom of the QR code
        // doc.fontSize(9).font('Helvetica-Bold').fillColor(qr.status === 'redeemed' ? 'red' : 'black');
        // doc.text(`Rs. ${Number(qr.cashbackAmount).toFixed(0)}`, currentX, labelY + 10, {
        //    width: cellWidth,
        //    align: 'center'
        // });
        // doc.fillColor('black');

        col += 1;
        if (col >= cols) {
            col = 0;
            currentX = startX;
            currentY += cellHeight;
        } else {
            currentX += cellWidth + 5;
        }
    }
};

/**
 * Get the buffer for the voucher template image.
 * Uses the converted assured_gift_card_placeholder.png.
 */
const getVoucherTemplateBuffer = (designUrl) => {
    if (!designUrl) return null;
    const uploadsRoot = path.resolve(__dirname, '../../uploads');
    const templatePath = path.resolve(uploadsRoot, 'assured_gift_card_placeholder.png');
    
    if (!fs.existsSync(templatePath)) {
        console.warn('Voucher template PNG not found:', templatePath);
        return null;
    }
    
    return fs.readFileSync(templatePath);
};

/**
 * Draw full-size print-ready voucher cards.
 * Each card will be on its own exact-size PDF page (88x55mm).
 * 88mm = 249.45 pts, 55mm = 155.91 pts.
 */
const drawVoucherCards = async ({
    doc,
    qrCodes,
    voucherDesignBuffer,
    brandName,
    brandLogoBuffer,
    voucherHeading,
    voucherSubtext,
    voucherExtraText,
    onProgress
}) => {
    // Exact business card size: 88 x 55 mm
    const cardWidthPts = 249.45;
    const cardHeightPts = 155.91;

    // QR code render size (high quality for print)
    const qrRenderSize = 300;

    // QR placement — precisely inside the black border box on the template.
    // Derived from image analysis: box starts at ~60.4% from left, ~28% from top,
    // box is ~28% of image width. Add small inner padding to avoid touching borders.
    const qrLeftPct = 0.625;
    const qrTopPct = 0.305;
    const qrSizePct = 0.390;

    let processedQrs = 0;

    for (let i = 0; i < qrCodes.length; i += 1) {
        const qr = qrCodes[i];
        const pageBuffers = await renderQrPageBuffers([qr], qrRenderSize);

        // Add a new exact-size page for this card with zero margin
        doc.addPage({
            size: [cardWidthPts, cardHeightPts],
            margin: 0
        });

        // Draw the full card template PNG as background (full bleed)
        doc.image(voucherDesignBuffer, 0, 0, {
            width: cardWidthPts,
            height: cardHeightPts
        });

        // ── Brand Logo at top-left ──
        const logoX = cardWidthPts * 0.06;
        const logoY = cardHeightPts * 0.08;
        if (brandLogoBuffer) {
            doc.image(brandLogoBuffer, logoX, logoY, {
                fit: [30, 30]
            });
        } else if (brandName) {
            // Fallback: draw brand name as text when no logo image is available
            doc.fillColor('#000000').fontSize(7).font('Helvetica-Bold');
            doc.text(brandName, logoX, logoY + 5, {
                width: cardWidthPts * 0.50,
                align: 'left',
                lineBreak: false
            });
        }

        // ── Custom Text on the left half of the card ──
        // Positioned below the logo with good spacing. Text stays within the left ~55% of the card.
        const textX = cardWidthPts * 0.06;
        const maxTextWidth = cardWidthPts * 0.50;
        let textY = cardHeightPts * 0.32;

        if (voucherHeading) {
            doc.fillColor('#1a1a1a').fontSize(14).font('Times-Bold');
            doc.text(voucherHeading, textX, textY, {
                width: maxTextWidth,
                align: 'left',
                lineBreak: true,
                height: cardHeightPts * 0.35,
                ellipsis: true
            });
            const headingHeight = doc.heightOfString(voucherHeading, { width: maxTextWidth });
            textY += Math.min(headingHeight, cardHeightPts * 0.35) + 5;
        }

        if (voucherSubtext) {
            doc.fillColor('#444444').fontSize(7).font('Helvetica');
            doc.text(voucherSubtext, textX, textY, {
                width: maxTextWidth,
                align: 'left',
                lineBreak: true,
                height: cardHeightPts * 0.20,
                ellipsis: true
            });
            const subHeight = doc.heightOfString(voucherSubtext, { width: maxTextWidth });
            textY += Math.min(subHeight, cardHeightPts * 0.20) + 4;
        }

        if (voucherExtraText) {
            doc.fillColor('#777777').fontSize(5).font('Helvetica-Oblique');
            doc.text(voucherExtraText, textX, textY, {
                width: maxTextWidth,
                align: 'left',
                lineBreak: true,
                height: cardHeightPts * 0.12,
                ellipsis: true
            });
        }

        // ── QR Code inside the border box ──
        const qrSize = cardHeightPts * qrSizePct;
        const qrX = cardWidthPts * qrLeftPct;
        const qrY = cardHeightPts * qrTopPct;

        doc.image(pageBuffers[0], qrX, qrY, {
            width: qrSize,
            height: qrSize
        });

        if (qr.status === 'redeemed') {
            doc.save();
            doc.fillColor('white').fillOpacity(0.85);
            doc.rect(qrX, qrY, qrSize, qrSize).fill();

            doc.fillColor('red').fillOpacity(1);
            doc.fontSize(10).font('Helvetica-Bold');
            const centerX = qrX + (qrSize / 2);
            const centerY = qrY + (qrSize / 2);
            doc.translate(centerX, centerY);
            doc.rotate(-45);
            doc.text("CLAIMED", -30, -5, { width: 60, align: 'center', lineBreak: false });
            doc.restore();
        }

        processedQrs += 1;
        await reportProgress(onProgress, processedQrs);
    }

    return processedQrs;
};

async function generateQrPdf({
    qrCodes,
    campaignTitle,
    orderId,
    brandName,
    brandLogoUrl,
    planType,
    productName,
    compactMode,
    allocations,
    batchLabel,
    qrRange,
    startSheetIndex,
    totalSheetCount,
    qrsPerSheet,
    voucherDesignUrl,
    voucherHeading = 'THANK YOU FOR SHOPPING WITH US.',
    voucherSubtext = 'Scan the QR code below and receive your assured cashback reward.',
    voucherExtraText = '',
    outputStream,
    onProgress
}) {
    // Check if we are in voucher card mode
    const voucherDesignBuffer = getVoucherTemplateBuffer(voucherDesignUrl);
    
    // Create the document. If in voucher mode, suppress the first page 
    // because we will add custom sized pages dynamically.
    const doc = new PDFDocument({
        size: 'A4',
        margin: 30,
        autoFirstPage: true
    });
    
    const chunks = [];
    const resultPromise = createPdfResultPromise(doc, outputStream, chunks);

    try {
    const vHeading = voucherHeading || 'THANK YOU FOR SHOPPING WITH US.';
    const vSubtext = voucherSubtext || 'Scan the QR code below and receive your assured cashback reward.';
    const vExtraText = voucherExtraText || '';

    const brandLogoBuffer = await getBrandLogoBuffer(brandLogoUrl);
    const safeQrCodes = Array.isArray(qrCodes) ? qrCodes : [];
    const isPostpaid = planType === 'postpaid';
        let processedQrs = 0;

        // ── Voucher Card Mode ──
        if (false && voucherDesignBuffer) {
            processedQrs = await drawVoucherCards({
                doc,
                qrCodes: safeQrCodes,
                voucherDesignBuffer,
                brandName,
                brandLogoBuffer,
                voucherHeading: vHeading,
                voucherSubtext: vSubtext,
                voucherExtraText: vExtraText,
                onProgress
            });
        } else if (isPostpaid) {
            // ── Regular Postpaid Grid (no voucher design) ──
            const logicalQrsPerSheet = Number.isFinite(Number(qrsPerSheet)) && Number(qrsPerSheet) > 0
                ? Number(qrsPerSheet)
                : DEFAULT_QRS_PER_GRID_PAGE;
            const totalSheets = Math.ceil(safeQrCodes.length / logicalQrsPerSheet);
            const sheetOffset = Number.isFinite(Number(startSheetIndex))
                ? Math.max(0, Number(startSheetIndex))
                : 0;
            const displayTotalSheets = Number.isFinite(Number(totalSheetCount)) && Number(totalSheetCount) > 0
                ? Number(totalSheetCount)
                : sheetOffset + totalSheets;
            let hasDrawnFirstPostpaidPage = false;

            for (let sheetIdx = 0; sheetIdx < totalSheets; sheetIdx += 1) {
                const globalSheetIdx = sheetOffset + sheetIdx;
                const sheetQrs = safeQrCodes.slice(
                    sheetIdx * logicalQrsPerSheet,
                    (sheetIdx + 1) * logicalQrsPerSheet
                );
                const pagesPerLogicalSheet = Math.max(
                    1,
                    Math.ceil(sheetQrs.length / DEFAULT_QRS_PER_GRID_PAGE)
                );

                for (let logicalPageIdx = 0; logicalPageIdx < pagesPerLogicalSheet; logicalPageIdx += 1) {
                    if (hasDrawnFirstPostpaidPage) doc.addPage();
                    hasDrawnFirstPostpaidPage = true;

                    const pageStart = logicalPageIdx * DEFAULT_QRS_PER_GRID_PAGE;
                    const pageQrs = sheetQrs.slice(pageStart, pageStart + DEFAULT_QRS_PER_GRID_PAGE);
                    const pageBuffers = await renderQrPageBuffers(pageQrs, 85);

                    const { yPos, effectiveBatchLabel } = drawPostpaidHeader({
                        doc,
                        brandLogoBuffer,
                        brandName,
                        campaignTitle,
                        productName,
                        sheetQrs,
                        globalSheetIdx,
                        displayTotalSheets,
                        logicalPageIdx,
                        pagesPerLogicalSheet,
                        batchLabel,
                        qrRange,
                        logicalQrsPerSheet,
                        allocations
                    });

                    drawPostpaidPageGrid({
                        doc,
                        pageQrs,
                        pageBuffers,
                        yPos,
                        globalSheetIdx,
                        pageStart,
                        voucherDesignBuffer: null,
                        batchLabel: effectiveBatchLabel
                    });

                    processedQrs += pageQrs.length;
                    await reportProgress(onProgress, processedQrs);
                }
            }
        } else {
            // ── Regular Prepaid Grid (no voucher design) ──
            const pageHeight = 780;
            const qrSize = 80;
            const labelHeight = 35;
            const cellHeight = qrSize + labelHeight + 10;
            const firstPageStartY = drawPrepaidHeader({
                doc,
                brandLogoBuffer,
                brandName,
                campaignTitle,
                productName,
                orderId,
                totalQrs: safeQrCodes.length
            });
            const firstPageCapacity = Math.max(
                1,
                Math.floor((pageHeight - firstPageStartY) / cellHeight) * 5
            );
            const continuationStartY = 50;
            const continuationCapacity = Math.max(
                1,
                Math.floor((pageHeight - continuationStartY) / cellHeight) * 5
            );

            let cursor = 0;
            let pageIndex = 0;
            while (cursor < safeQrCodes.length) {
                if (pageIndex > 0) doc.addPage();

                const pageCapacity = pageIndex === 0 ? firstPageCapacity : continuationCapacity;
                const pageStartY = pageIndex === 0 ? firstPageStartY : continuationStartY;
                const pageQrs = safeQrCodes.slice(cursor, cursor + pageCapacity);
                const pageBuffers = await renderQrPageBuffers(pageQrs, qrSize);

                drawPrepaidPageGrid({
                    doc,
                    pageQrs,
                    pageBuffers,
                    startY: pageStartY,
                    voucherDesignBuffer: null
                });

                cursor += pageQrs.length;
                pageIndex += 1;
                processedQrs += pageQrs.length;
                await reportProgress(onProgress, processedQrs);
            }
        }

        doc.end();
        return await resultPromise;
    } catch (error) {
        if (outputStream && !outputStream.destroyed) {
            outputStream.destroy(error);
        }
        doc.destroy();
        throw error;
    }
}

const generateQrPdfToFile = async (filePath, options) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const outputStream = fs.createWriteStream(filePath);
    await generateQrPdf({
        ...options,
        outputStream
    });
    return filePath;
};

module.exports = {
    generateQrPdf,
    generateQrPdfToFile
};
