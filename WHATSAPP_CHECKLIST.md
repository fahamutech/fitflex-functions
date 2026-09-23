# WhatsApp Integration Checklist — Production Ready

## ✅ Backend Code Status
- [x] WhatsApp service implemented (21 tests passing)
- [x] 11 REST endpoints created
- [x] Async Knex integration
- [x] Audit logging
- [x] Phone normalization (Tanzania, Uganda, Kenya)
- [x] Error handling & validation
- [x] Inbound webhook handler

## 🔧 Configuration Steps (Do These Now)

### 1. Set API Key
```bash
# Edit .env file and add:
AFRICAS_TALKING_API_KEY=your_key_from_at_dashboard
AFRICAS_TALKING_API_URL=https://api.sandbox.africastalking.com
```

### 2. Test Connection
```bash
cd /opt/data/fitflex-functions
node test-africas-talking.mjs
```
Expected: ✅ Authentication successful

### 3. Register 9 Message Templates
Go to: Africa's Talking Dashboard → WhatsApp → Templates

Copy-paste these exact templates:

**Template 1: fitflex_otp**
- Category: AUTHENTICATION
- Body: `Hi {{name}}, your FitFlex OTP is {{code}}. Valid for 10 minutes. Reply STOP to opt out.`

**Template 2: fitflex_booking_confirmed**
- Category: TRANSACTIONAL
- Body: `{{trainerName}}, you have a new booking from {{memberName}} on {{date}} at {{time}}. View details in your FitFlex app.`

**Template 3: fitflex_booking_reminder**
- Category: TRANSACTIONAL
- Body: `Hi {{name}}, reminder: your session with {{trainer}} is in 1 hour at FitFlex.`

**Template 4: fitflex_trainer_message**
- Category: SERVICE_UPDATE
- Body: `{{memberName}}, your trainer {{trainerName}} sent: {{message}}`

**Template 5: fitflex_order_placed**
- Category: TRANSACTIONAL
- Body: `{{memberName}}, order #{{orderId}} placed! Total: {{amount}} TZS. Pick up at any nearby gym or arrange delivery.`

**Template 6: fitflex_order_ready**
- Category: TRANSACTIONAL
- Body: `{{memberName}}, order #{{orderId}} is ready at {{gymName}}. Pick up by {{date}}.`

**Template 7: fitflex_payment_received**
- Category: TRANSACTIONAL
- Body: `Payment {{amount}} TZS received for order #{{orderId}}. Thank you for shopping at FitFlex!`

**Template 8: fitflex_vendor_reengagement**
- Category: MARKETING
- Body: `Hey {{name}}, you haven't had sales in 7 days. Check your FitFlex dashboard for optimization tips or contact support.`

**Template 9: fitflex_member_reengagement**
- Category: MARKETING
- Body: `{{name}}, your favorite trainers have new availability! Book a session now and get 20% off your first booking. Visit FitFlex app.`

### 4. Configure Webhook
Go to: Africa's Talking Dashboard → WhatsApp → Webhooks

Set these URLs:
- **Inbound URL:** `https://your-backend-domain.com/whatsapp/webhook`
- **Status URL (optional):** `https://your-backend-domain.com/whatsapp/webhook/status`

⚠️ Important:
- Must be HTTPS (not HTTP)
- Must be publicly accessible
- Port 443 (standard HTTPS)

### 5. Run Tests
```bash
node --test specs/whatsapp-service.specs.mjs
```
Expected: 21/21 passing

---

## 🎯 Integration Tasks (Then Do These)

### Integration 1: Shop Service (Order Notifications)
File: `src/services/shop-service.mjs`

When order is placed, add:
```javascript
import { whatsAppService } from '../bootstrap/services.mjs';

async function placeOrder(...) {
  // ... existing code ...
  
  // Send WhatsApp notification to buyer
  await whatsAppService.sendOrderPlaced(buyerId, order.id, order.totalTzs);
}
```

When order status changes to ready:
```javascript
async function updateOrderStatus(orderId, status) {
  // ... existing code ...
  
  if (status === 'ready_for_pickup') {
    const order = await shopOrders.findByIdAsync(orderId);
    await whatsAppService.sendOrderReady(order.buyerId, orderId, order.gymName, readyByDate);
  }
}
```

### Integration 2: Trainer Service (Booking Notifications)
File: `src/services/trainer-booking-service.mjs` (or wherever bookings are created)

When booking confirmed:
```javascript
import { whatsAppService } from '../bootstrap/services.mjs';

async function confirmBooking(bookingId) {
  const booking = await trainerBookings.findByIdAsync(bookingId);
  const trainer = await trainers.findByIdAsync(booking.trainerId);
  const member = await users.findByIdAsync(booking.memberId);
  
  // Send WhatsApp to trainer
  await whatsAppService.sendBookingConfirmed(
    booking.trainerId,
    member.displayName,
    formatDate(booking.date),
    formatTime(booking.time)
  );
}
```

### Integration 3: Auth Service (OTP Delivery)
File: `src/services/auth-service.mjs`

When OTP is generated for login/2FA:
```javascript
import { whatsAppService } from '../bootstrap/services.mjs';

async function sendLoginOtp(userId, code) {
  const user = await users.findByIdAsync(userId);
  
  // Send via WhatsApp
  await whatsAppService.sendOtp(userId, code, user.displayName);
  
  // Also save to OTP table for verification
  await otps.insertAsync({
    id: makeId('otp'),
    userId,
    code,
    method: 'whatsapp', // Track which method was used
    expiresAt: addMinutes(now(), 10),
    createdAt: now(),
  });
}
```

---

## 📊 Monitoring & Operations

### Check Message Delivery
View delivery reports in: Africa's Talking Dashboard → WhatsApp → Message Analytics

### Monitor Costs
- Budget: ~$2,340/month for 10k active users (moderate usage)
- Monitor actual usage in: Dashboard → Billing → Usage Statistics

### Error Handling
Common errors in responses:
- `invalid_phone_format` — Phone number doesn't match East African format
- `failed_to_send` — Africa's Talking API error (check template approval)
- `network_error` — Connectivity issue (retry with backoff)
- `user_no_phone` — User missing phone number

---

## 🚀 Production Deployment Checklist

- [ ] API key set in production environment variables
- [ ] All 9 templates registered and approved by Africa's Talking
- [ ] Webhook URL updated to production domain (HTTPS)
- [ ] Database migrations run (whatsapp_logs table if audit logging)
- [ ] Rate limiting configured (10 msgs/sec per user recommended)
- [ ] Error monitoring & alerting set up (e.g., Sentry, DataDog)
- [ ] Cost budget approved (alert when usage exceeds threshold)
- [ ] Shop service integrated (order notifications)
- [ ] Trainer service integrated (booking notifications)
- [ ] Auth service integrated (OTP delivery)
- [ ] User privacy policy updated (mention WhatsApp messaging)
- [ ] Load testing done (simulate 1000+ concurrent users)
- [ ] Webhook signature validation implemented
- [ ] Delivery failure retry logic configured
- [ ] Team trained on monitoring & troubleshooting

---

## 🐛 Troubleshooting

**Q: "Template not found" error**
A: Ensure template names match EXACTLY (case-sensitive):
   - fitflex_otp (not fitflex_OTP or fitflex-otp)

**Q: "Invalid phone format" error**
A: Phone must be in format +255XXXXXXXXX (11 digits total for Tanzania)
   The service normalizes: 0712345678 → +255712345678

**Q: Webhook not receiving messages**
A: Check:
   1. Webhook URL is HTTPS (not HTTP)
   2. Domain is publicly accessible
   3. Port 443 is open
   4. Firewall allows incoming traffic from Africa's Talking IPs

**Q: Messages not sending (API 500 error)**
A: Check:
   1. API key is correct
   2. API URL matches environment (sandbox vs production)
   3. Template name matches registered template
   4. All {{variables}} are provided in API call

---

## 📚 Reference Links

- Africa's Talking WhatsApp Docs: https://africastalking.com/whatsapp
- WhatsApp Business API: https://developers.facebook.com/docs/whatsapp/cloud-api
- FitFlex WhatsApp Setup: ./WHATSAPP_SETUP.md
- WhatsApp Integration Guide: ./WHATSAPP_INTEGRATION_COMPLETE.md

---

**Last Updated:** 2026-09-23
**Status:** Ready for configuration & integration
