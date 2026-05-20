async function sendOtp() {
  try {
    const res = await fetch("http://localhost:5000/api/auth/send-otp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        phoneNumber: "8287123014"
      })
    });
    const status = res.status;
    const data = await res.json();
    console.log("Status Code:", status);
    console.log("Response:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error triggering OTP:", err);
  }
}

sendOtp();
