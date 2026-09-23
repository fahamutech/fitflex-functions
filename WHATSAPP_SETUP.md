// Africa's Talking WhatsApp Integration Setup Guide
// FitFlex platform

## Setup Steps

### 1. Create Africa's Talking Account
- Go to https://africastalking.com
- Sign up for a Business account
- Navigate to Dashboard → WhatsApp → Get Started
- Create a WhatsApp Business Account (linked to your business)

### 2. Configure API Credentials
- Copy your API Key from Dashboard → Settings → API Keys
- Set environment variable: `AFRICAS_TALKING_API_KEY=your_key_here`
- Use sandbox (`username: sandbox`) for testing; production when approved

### 3. Register Message Templates
Pre-approval is required. Log into Africa's Talking dashboard and register these templates:

```
Template Name: fitflex_otp
Category: AUTHENTICATION
Body: Hi {{name}}, your FitFlex OTP is {{code}}. Valid for 10 minutes. Reply STOP to opt out.

Template Name: fitflex_booking_confirmed
Category: TRANSACTIONAL
Body: {{trainerName}}, you have a new booking from {{memberName}} on {{date}} at {{time}}. View details in your FitFlex app.

Template Name: fitflex_booking_reminder
Category: TRANSACTIONAL
Body: Hi {{name}}, reminder: your session with {{trainer}} is in 1 hour at FitFlex.

Template Name: fitflex_trainer_message
Category: SERVICE_UPDATE
Body: {{memberName}}, your trainer {{trainerName}} sent: {{message}}

Template Name: fitflex_order_placed
Category: TRANSACTIONAL
Body: {{memberName}}, order #{{orderId}} placed! Total: {{amount}} TZS. Pick up at any nearby gym or arrange delivery.

Template Name: fitflex_order_ready
Category: TRANSACTIONAL
Body: {{memberName}}, order #{{orderId}} is ready at {{gymName}}. Pick up by {{date}}.

Template Name: fitflex_payment_received
Category: TRANSACTIONAL
Body: Payment {{amount}} TZS received for order #{{orderId}}. Thank you for shopping at FitFlex!

Template Name: fitflex_vendor_reengagement
Category: MARKETING
Body: Hey {{name}}, you haven't had sales in 7 days. Check your FitFlex dashboard for optimization tips or contact support.

Template Name: fitflex_member_reengagement
Category: MARKETING
Body: {{name}}, your favorite trainers have new availability! Book a session now and get 20% off your first booking. Visit FitFlex app.
```

### 4. Set Up Webhook for Inbound Messages
- In FitFlex backend, the endpoint `/whatsapp/webhook` receives inbound messages
- Configure in Africa's Talking Dashboard → WhatsApp → Webhooks:
  - Inbound URL: `https://your-fitflex-backend.com/whatsapp/webhook`
  - Status delivery URL: (optional, for delivery receipts)
- Africa's Talking will POST inbound messages and status updates to this URL

### 5. Test in Sandbox
Before production:
```bash
curl -X POST http://localhost:3000/whatsapp/send-otp \
  -H "Content-Type: application/json" \
  -d '{"userId": "user_123", "code": "123456"}'
```

### 6. Production Approval
- Submit WhatsApp Business account to Facebook for approval
- Africa's Talking will verify your business and enable production mode
- Update `apiUrl` from sandbox to production in whatsapp-service.mjs

---

## Service Methods

### OTP & Auth
```
sendOtp(userId, code, name?) → Promise<{ok, messageId, cost} | {error}>
```
Send one-time password for login/2FA.

### Booking Notifications
```
sendBookingConfirmed(trainerId, memberName, date, time) → Promise
sendBookingReminder(userId, trainerName, minutesUntil?) → Promise
```

### Trainer-Member Chat
```
sendTrainerMessage(memberId, trainerName, message) → Promise
handleInboundMessage({from, text, messageId, timestamp}) → Promise<{message}>
```

### E-Commerce Notifications
```
sendOrderPlaced(memberId, orderId, amount) → Promise
sendOrderReady(memberId, orderId, gymName, readyBy) → Promise
sendPaymentReceived(userId, amount, orderId) → Promise
```

### Re-Engagement Campaigns
```
sendVendorReengagement(vendorId) → Promise
sendMemberReengagement(memberId) → Promise
```

---

## Cost Estimation (Africa's Talking Pricing)

Pricing as of Sept 2026 (verify current rates):
- Outbound message: ~$0.08-0.12 per message (varies by country)
- Inbound message: ~$0.02-0.04 per message
- OTP: May have special discounted rates

### Monthly Cost Example (10k members active)
- 50% send OTP weekly: 5k × 4 weeks = 20k messages @ $0.10 = $2,000
- 20% send order notifications: 2k × 2 orders/month = 4k @ $0.08 = $320
- 10% receive trainer messages: 1k messages @ $0.02 inbound = $20
- **Total: ~$2,340/month for moderate usage**

Negotiate volume discounts with Africa's Talking for higher volumes.

---

## Error Handling

Common errors:
- `invalid_phone_format` — User's phone number invalid or missing
- `failed_to_send` — Africa's Talking API returned error (check template approval status)
- `network_error` — Network/DNS failure (retry logic recommended)
- `user_no_phone` — User has no stored phone number

---

## Integration with Existing Services

### Shop Service
When order is placed: `await whatsAppService.sendOrderPlaced(buyerId, orderId, totalAmount);`

### Trainer Service
When booking confirmed: `await whatsAppService.sendBookingConfirmed(trainerId, memberName, date, time);`

### Auth Service (optional)
For 2FA OTP: `await whatsAppService.sendOtp(userId, code);`

---

## Security Notes

1. Never log API keys or phone numbers in plaintext
2. Validate `from` phone against user's stored phone in inbound webhooks
3. Rate-limit bulk sends to prevent abuse (10 msgs/sec per user recommended)
4. HTTPS only for webhook endpoints
5. Verify webhook signatures (Africa's Talking can send `X-Africa's-Talking-Signature`)

---

## Testing Sandbox Account

Africa's Talking provides test numbers you can message from:
- Use `username: sandbox`
- Test phone: +1 234 567 8901 (for testing inbound webhooks locally)

---

## Production Checklist

- [ ] Africa's Talking Business account approved
- [ ] All 9 message templates approved by Africa's Talking
- [ ] Webhook endpoint HTTPS and accessible
- [ ] Database storing whatsapp_logs for audit trail
- [ ] Rate limiting configured
- [ ] API key stored in environment variables (not code)
- [ ] Error monitoring & alerting set up
- [ ] Cost budget approved
- [ ] User consent: ensure users opted in to WhatsApp notifications
- [ ] Privacy policy updated mentioning WhatsApp messaging
