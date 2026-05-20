const express = require('express');
const router = express.Router();

// Used for webhook verification by Meta
router.get('/', (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const verifyToken = String(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "").trim();

  if (mode === "subscribe" && token === verifyToken) {
    console.log("[WhatsApp Webhook] Verified successfully.");
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ message: "Verification failed." });
  }
});

// Used to receive real-time message statuses
router.post('/', (req, res) => {
  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  
  if (value?.statuses?.[0]) {
    const status = value.statuses[0];
    console.log(`[WhatsApp Webhook] Status update: ${status.status} for ${status.recipient_id}`);
  }
  
  res.sendStatus(200);
});

module.exports = router;
