/**
 * WhatsApp OTP Service - Meta Cloud API Integration
 * Sends OTP messages via the Meta Graph API.
 */

const maskPhone = (value = "") => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? `***${digits.slice(-4)}` : "unknown";
};

const getWhatsAppConfig = () => {
  const graphVersion = String(process.env.WHATSAPP_GRAPH_VERSION || "").trim().replace(/^\/+|\/+$/g, "");
  return {
    graphVersion,
    phoneNumberId: String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim(),
    accessToken: String(process.env.WHATSAPP_ACCESS_TOKEN || "").trim(),
    templateName: String(process.env.WHATSAPP_OTP_TEMPLATE_NAME || "").trim(),
    templateLanguage: String(process.env.WHATSAPP_OTP_TEMPLATE_LANGUAGE || "en").trim(),
    isConfigured: Boolean(
      process.env.WHATSAPP_GRAPH_VERSION &&
      process.env.WHATSAPP_PHONE_NUMBER_ID &&
      process.env.WHATSAPP_PHONE_NUMBER_ID !== 'your_phone_number_id' &&
      process.env.WHATSAPP_ACCESS_TOKEN
    )
  };
};

const buildBodyComponent = (otpCode) => ({
  type: "body",
  parameters: [{ type: "text", text: otpCode }]
});

const buildUrlButtonComponent = (otpCode) => ({
  type: "button",
  sub_type: "url",
  index: "0",
  parameters: [{ type: "text", text: otpCode }]
});

const getOtpTemplateComponents = ({ otpCode, mode }) => {
  if (mode === "url_button_only") return [buildUrlButtonComponent(otpCode)];
  return [buildBodyComponent(otpCode), buildUrlButtonComponent(otpCode)];
};

/**
 * Send an OTP via WhatsApp Cloud API.
 * @param {Object} params
 * @param {string} params.to - Recipient phone number (e.g. "919876543210" or "9876543210")
 * @param {string} params.otpCode - The 6-digit OTP code
 */
const sendWhatsappOtp = async ({ to, otpCode }) => {
  const config = getWhatsAppConfig();

  if (!config.isConfigured) {
    console.warn("[WhatsApp OTP] Missing configuration. Falling back to console logging.");
    console.log(`[DEV] WhatsApp OTP for ${maskPhone(to)}: ${otpCode}`);
    return { delivered: true, simulated: true };
  }

  // Ensure country code is present (must start with country code, e.g. 91 for India)
  let cleaned = String(to).replace(/\D/g, "");
  if (!cleaned.startsWith("91") && cleaned.length === 10) {
    cleaned = "91" + cleaned;
  }

  const url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;
  
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: cleaned,
    type: "template",
    template: {
      name: config.templateName,
      language: { code: config.templateLanguage },
      components: getOtpTemplateComponents({ otpCode, mode: "body_and_url_button" })
    }
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      console.error("[WhatsApp Send Error]:", data?.error || data);
      return { delivered: false, error: data?.error?.message || "Unable to send WhatsApp verification code." };
    }

    return { delivered: true, id: data?.messages?.[0]?.id };
  } catch (error) {
    console.error("[WhatsApp Send Exception]:", error);
    return { delivered: false, error: error.message };
  }
};

module.exports = {
  sendWhatsappOtp
};
