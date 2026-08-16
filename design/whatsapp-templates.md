# AVO Beauty — WhatsApp message templates

Four customer-facing messages. All go to the **customer**, so all need **EN + AR** —
this is the one place Arabic is required outside the customer app.

WhatsApp Business requires these to be **pre-approved templates** before you can send
them outside a 24-hour service window. Submit them early; approval is not instant.
Variables are positional (`{{1}}`, `{{2}}`…) — that is WhatsApp's format, not ours.

**Rules that apply to all four**
- Money: 3 decimals, Western digits, always with `KD` / `د.ك`.
- Times: 12-hour with AM/PM in EN; Arabic uses ص/م.
- Arabic uses **feminine address forms** — the customer base is women's salons.
- The salon name, not "AVO", is the sender identity. AVO is invisible to the customer.
- Never include a balance in a message that could be read over someone's shoulder in a
  group. Balance goes in the receipt only.

---

## 1. Booking confirmation
**Trigger:** booking created, deposit held.
**Category:** Utility.

**EN**
```
Your booking at {{1}} is confirmed.

{{2}} with {{3}}
{{4}} at {{5}}

Deposit held: {{6}} KD — the remainder is paid at the salon.
Can't make it? Cancel in the app and the deposit returns to your wallet.
```
`{{1}}` salon · `{{2}}` service · `{{3}}` artist · `{{4}}` day · `{{5}}` time · `{{6}}` deposit

**AR**
```
تم تأكيد حجزكِ في {{1}}.

{{2}} مع {{3}}
{{4}} الساعة {{5}}

العربون المحجوز: {{6}} د.ك — والباقي يُدفع في الصالون.
ما تقدرين تحضرين؟ ألغي الحجز من التطبيق ويرجع العربون لمحفظتكِ.
```

---

## 2. Day-before reminder
**Trigger:** 24h before `startsAt`.
**Category:** Utility.

**EN**
```
Reminder — {{1}} tomorrow at {{2}}.

{{3}} with {{4}}
Deposit held: {{5}} KD

If you don't arrive within an hour of your slot, the deposit returns to your wallet
automatically.
```

**AR**
```
تذكير — {{1}} بكرة الساعة {{2}}.

{{3}} مع {{4}}
العربون المحجوز: {{5}} د.ك

إذا ما وصلتِ خلال ساعة من موعدكِ، يرجع العربون لمحفظتكِ تلقائياً.
```

---

## 3. Payment receipt
**Trigger:** `POST /charges` settles, or a shop order completes.
**Category:** Utility.

**EN — tiers salon**
```
{{1}} — receipt

{{2}}
Charged: {{3}} KD{{4}}
New balance: {{5}} KD

{{6}}
```
`{{4}}` optional deposit line, e.g. `\n(deposit 5.000 KD applied)` — empty string when none.
`{{6}}` loyalty line: `Visit added · 5 of 10 to Gold` or `You reached Gold — enjoy 10 → 12 on your next top-up.`

**EN — stamps salon**, `{{6}}` becomes:
`Stamp added · 5 of 8` or `Your 8th stamp — your free blow-dry is ready to claim.`

**AR**
```
{{1}} — إيصال

{{2}}
المخصوم: {{3}} د.ك{{4}}
الرصيد الجديد: {{5}} د.ك

{{6}}
```
`{{6}}` AR variants: `زيارة مسجّلة · ٥ من ١٠ للذهبية` · `ختم جديد · ٥ من ٨` ·
`وصلتِ للمستوى الذهبي` · `ختمكِ الثامن — تصفيف الشعر المجاني جاهز.`

---

## 4. Deposit returned (no-show)
**Trigger:** 1 hour after a missed slot, deposit auto-returned.
**Category:** Utility.

This message does the most product work of the four: it has to feel like a refund, not a
reprimand. The no-show rule exists to create commitment, not punishment — the copy has to
carry that or the rule reads as a penalty.

**EN**
```
{{1}} — your deposit is back.

We missed you at {{2}} on {{3}}. Your {{4}} KD deposit has returned to your wallet.

Book again whenever you're ready.
```

**AR**
```
{{1}} — رجع عربونكِ.

افتقدناكِ في موعد {{2}} يوم {{3}}. رجع عربونكِ {{4}} د.ك إلى محفظتكِ.

احجزي من جديد وقتما تحبين.
```

---

## Not templates — in-session only
These can be free-form (inside the 24h window) or don't exist yet:
- Top-up confirmation → the app already shows it; a message would be noise.
- Win-back / retention campaigns → **phase 2**, and Marketing category, which has
  stricter approval and opt-out requirements. Do not ship these with v1.

## Delivery notes for engineering
- Send is **queued and retried**, never blocking a charge or a booking.
- A failed WhatsApp send must never roll back the transaction that triggered it.
- Respect `salon.whatsappEnabled`; when off, no messages of any kind.
- Log template + variables + delivery status per send — merchants will ask "did she get it?"
