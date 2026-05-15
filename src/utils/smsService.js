/**
 * SMS Service - MShastra Gateway Integration
 * Sends OTP messages via the MShastra HTTP API.
 */

const SMS_CONFIG = {
    baseUrl: 'http://mshastra.com/sendurl.aspx',
    user: process.env.MSHASTRA_USER || 'ARWRDS',
    pwd: process.env.MSHASTRA_PWD || 'py44bhe4',
    senderId: process.env.MSHASTRA_SENDER_ID || 'ASRD',
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

    const message = `Dear Customer Your login OTP is ${otp} Do not share this code . Thanks ASRD https://assuredrewards.in/signin`;

    // Build GET URL — sendurl.aspx is the endpoint that actually delivers SMS
    // Requires IP whitelisting in MShastra panel
    const params = new URLSearchParams({
        user: SMS_CONFIG.user,
        pwd: SMS_CONFIG.pwd,
        senderid: SMS_CONFIG.senderId,
        CountryCode: SMS_CONFIG.countryCode,
        mobileno: cleaned,
        msgtext: message,
    });

    const url = `${SMS_CONFIG.baseUrl}?${params.toString()}`;

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
