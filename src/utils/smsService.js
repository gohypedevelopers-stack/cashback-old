/**
 * SMS Service - MShastra Gateway Integration
 * Sends OTP messages via the MShastra HTTP API.
 */

const SMS_CONFIG = {
    baseUrl: 'https://mshastra.com/sendurl.aspx', // Switched to HTTPS
    user: (process.env.MSHASTRA_USER || 'ARWRDS').trim(),
    pwd: (process.env.MSHASTRA_PWD || 'py44bhe4').trim(),
    senderId: (process.env.MSHASTRA_SENDER_ID || 'ASRD').trim(),
    entityId: (process.env.MSHASTRA_ENTITY_ID || '').trim(),
    templateId: (process.env.MSHASTRA_TEMPLATE_ID || '').trim(),
    countryCode: '91',
};

/**
 * Send an OTP SMS to a mobile number via MShastra gateway.
 * @param {string} mobileNumber - 10-digit Indian mobile number (without country code)
 * @param {string} otp - The OTP code to send
 * @returns {Promise<{success: boolean, response?: string, error?: string}>}
 */
const sendOTPSms = async (mobileNumber, otp) => {
    // Strip any leading +91 or 91 prefix to get raw 10-digit number
    let cleaned = String(mobileNumber).replace(/[\s\-()]/g, '');
    if (cleaned.startsWith('+91')) cleaned = cleaned.slice(3);
    else if (cleaned.startsWith('91') && cleaned.length === 12) cleaned = cleaned.slice(2);

    // EXACT template match from DLT screenshot
    const message = `Dear Customer Your login OTP is ${otp} Do not share this code . Thanks ASRD https://assuredrewards.in/signin`;

    // Manual query string construction to ensure %20 for spaces and 91 prefix
    const payload = {
        user: SMS_CONFIG.user,
        pwd: SMS_CONFIG.pwd,
        senderid: SMS_CONFIG.senderId,
        mobileno: '91' + cleaned, // Prefixed 91 directly
        msgtext: message,
        msgtype: '3', // Some gateways use '3' for Transactional/DLT
        // Send all common variations to ensure the gateway picks the right one
        entityid: SMS_CONFIG.entityId,
        peid: SMS_CONFIG.entityId,
        tempid: SMS_CONFIG.templateId,
        templateid: SMS_CONFIG.templateId,
        dlt_template_id: SMS_CONFIG.templateId
    };

    const queryString = Object.entries(payload)
        .filter(([_, val]) => val !== undefined && val !== '')
        .map(([key, val]) => `${key}=${encodeURIComponent(val).replace(/\+/g, '%20')}`)
        .join('&');

    const url = `${SMS_CONFIG.baseUrl}?${queryString}`;
    
    // Log the URL for debugging (masking password)
    const maskedUrl = url.replace(`pwd=${SMS_CONFIG.pwd}`, 'pwd=********');
    console.log(`[SMS DEBUG] Request URL: ${maskedUrl}`);

    try {
        const response = await fetch(url);
        const text = await response.text();
        const trimmed = text.trim();
        console.log(`[SMS] Response for ${cleaned}: "${trimmed}"`);

        if (trimmed.toLowerCase().includes('whitelist')) {
            console.error(`[SMS ERROR] IP not whitelisted in MShastra panel. Whitelist your server IP.`);
            return { success: false, error: 'IP not whitelisted. SMS not delivered.' };
        }

        if (trimmed.toLowerCase().includes('success') || /^\d+$/.test(trimmed)) {
            return { success: true, response: trimmed };
        }

        console.error(`[SMS WARNING] Unexpected gateway response: ${trimmed}`);
        return { success: false, error: trimmed };
    } catch (error) {
        console.error(`[SMS ERROR] Failed to send OTP to ${cleaned}:`, error.message);
        return { success: false, error: error.message };
    }
};

module.exports = { sendOTPSms };
