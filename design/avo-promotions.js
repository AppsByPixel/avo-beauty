/* AVO shared promotions endpoint.
 * One source of truth for branch boosts, happy-hour windows, campaign
 * approvals and staff authority. The wallet, the merchant dashboard, the
 * staff scanner and the owner console all read and write through here.
 *
 * Stands in for GET/PUT /v1/salons/:id/promotions — same shapes, same
 * status machine, backed by localStorage + a change subscription so every
 * surface open in the browser stays in step.
 */
(function () {
  var KEY = 'avo.promotions.v1';
  // Idempotent: this file is loaded by four apps and re-evaluated whenever a
  // host remounts. Replacing the singleton would orphan live subscriptions.
  if (window.AVOPromotions && window.AVOPromotions.KEY === KEY) return;
  var subs = [];
  var mem = null;

  var REWARDS = {
    x2stamp: { en: 'Double stamps', ar: 'ختمان بدل ختم' },
    x3stamp: { en: 'Triple stamps', ar: 'ثلاثة أختام' },
    x2visit: { en: 'Double visit credit', ar: 'رصيد زيارة مضاعف' },
    topup10: { en: '+10% top-up bonus', ar: '+١٠٪ على الشحن' },
    topup20: { en: '+20% top-up bonus', ar: '+٢٠٪ على الشحن' },
    credit3: { en: '3 KD wallet credit', ar: '٣ د.ك رصيد' },
    none: { en: 'No reward', ar: 'بدون مكافأة' }
  };

  var SEED = {
    version: 2,
    /* `social` = the salon's own public channels, shown in the wallet under
       Help. Salon-owned (Merchant -> Settings), unlike `support` below which
       AVO owns. `on:false` hides the icon without losing the handle. */
    salon: { id: 'SLN-AMARA', name: 'Amara', nameAr: 'أمارا',
      social: [
        { id: 'instagram', label: 'Instagram', handle: '@amara.kw', on: true },
        { id: 'tiktok', label: 'TikTok', handle: '@amarasalon', on: true },
        { id: 'snapchat', label: 'Snapchat', handle: 'amarasalon', on: true },
        { id: 'whatsapp', label: 'WhatsApp', handle: '+965 2222 9080', on: true }
      ]
    },
    branches: [
      { id: 'BR-KWT', name: 'Kuwait City', nameAr: 'مدينة الكويت' },
      { id: 'BR-SAL', name: 'Salmiya', nameAr: 'السالمية' }
    ],
    boosts: {
      'BR-KWT': { visit: 2, topup: 10, stamp: 2 },
      'BR-SAL': { visit: 1, topup: 0, stamp: 1 }
    },
    boostsPublishedAt: null,
    happy: [
      { id: 'h1', branchId: 'BR-KWT', days: [0, 1, 2, 3], from: '11:00', to: '14:00', reward: 'x2stamp', on: true, notify: true },
      { id: 'h2', branchId: 'BR-SAL', days: [1, 2], from: '16:00', to: '18:00', reward: 'topup10', on: false, notify: false }
    ],
    campaigns: [
      { id: 'c-1004', title: 'Salmiya Thursday late night', body: 'We are open until midnight on Thursday — every visit counts double.', channel: 'push', audience: 'all', branchId: 'BR-SAL', reward: 'x2visit', reach: 612, when: 'now', scheduledAt: '2026-07-04T18:00', status: 'sent', submittedBy: 'Rana Al-Sabah', submittedAt: '2026-07-03T09:12', decidedBy: 'Yousef', decidedAt: '2026-07-03T11:40', note: '', result: '612 reached · 148 booked' },
      { id: 'c-1007', title: 'Wallet running low', body: 'Your Amara balance is under 5 KD — top up and get 10% more.', channel: 'push', audience: 'lowbal', branchId: 'all', reward: 'topup10', reach: 312, when: 'recurring', scheduledAt: '', status: 'approved', submittedBy: 'Rana Al-Sabah', submittedAt: '2026-06-20T10:05', decidedBy: 'Yousef', decidedAt: '2026-06-20T12:20', note: 'Standing approval — triggers under 5 KD.', result: '' },
      { id: 'c-1011', title: 'We miss you — 3 KD back', body: 'It has been a while. Here is 3 KD on your card for your next blow-dry.', channel: 'wa', audience: 'lapsed', branchId: 'all', reward: 'credit3', reach: 186, when: 'later', scheduledAt: '2026-08-09T10:00', status: 'pending', submittedBy: 'Rana Al-Sabah', submittedAt: '2026-08-02T16:31', decidedBy: '', decidedAt: '', note: '', result: '' }
    ],
    policy: { requireApproval: true, weeklyCapPerCustomer: 2, monthlyCapPerSalon: 8, quietFrom: '22:00', quietTo: '09:00' },
    team: [
      { id: 't1', name: 'Rana Al-Sabah', handle: '@rana', role: 'manager', branch: 'all', perms: { dashboard: true, appointments: true, shop: true, loyalty: true, team: true, scanner: true, charges: true, void: true, marketing: true } },
      { id: 't2', name: 'Dana Yousef', handle: '@dana', role: 'frontdesk', branch: 'Salmiya', perms: { dashboard: true, appointments: true, shop: false, loyalty: false, team: false, scanner: true, charges: true, void: false, marketing: false } },
      { id: 't3', name: 'Hessa M.', handle: '@hessa', role: 'stylist', branch: 'Kuwait City', perms: { dashboard: false, appointments: true, shop: false, loyalty: false, team: false, scanner: true, charges: false, void: false, marketing: false } }
    ],
    policies: (function () {
      var docs = [
        { id: 'gterms', consent: true, scope: 'platform',
          title: { en: 'Terms & conditions', ar: 'الشروط والأحكام' },
          body: { en: [
            "1. Who you are dealing with. AVO is a technology platform operated by AVO Beauty Technologies, registered in Kuwait. The salon — not AVO — provides the service you book and is responsible for it. When you book or pay you are contracting with the salon and using AVO to do it.",
            "2. Your account. An account is personal and tied to your phone number. Keep your password to yourself and tell us straight away if you think someone else has used your account. You must be 18 or over, or have a guardian's consent.",
            "3. Booking and deposits. A booking is held with a deposit taken from your wallet and counted towards the service. Cancel an hour or more ahead and the deposit comes back in full; cancel later or miss the slot and the salon may keep it.",
            "4. Prices. Prices are in Kuwaiti dinar, include any applicable tax, are set by the salon and can change. The price shown when you confirm is the price that binds.",
            "5. Wallet credit. Your balance is prepaid credit for the named salon only. It is not a bank deposit, is not covered by deposit insurance, earns no interest and cannot be withdrawn as cash. Card and KNET payments are processed by a payment provider licensed by the Central Bank of Kuwait.",
            "6. Products. Shop items are collected at the salon. Opened or used products cannot be returned for hygiene reasons; a damaged or wrong item is replaced or returned as wallet credit.",
            "7. Fair use. Do not misuse the app, try to reach other people's accounts, or exploit rewards dishonestly. Where we find abuse we may suspend an account, settling any remaining balance with you.",
            "8. Liability. AVO is responsible for the platform working and for your transaction record. The outcome of the service in the chair is the salon's responsibility. Neither party is liable for indirect loss, and AVO's liability is in any case limited to what you have paid through the platform in the last 12 months.",
            "9. Complaints. Message the salon first, from inside the app. If it is not resolved in 7 days AVO will step in and mediate. Payment queries must be raised within 30 days of the transaction.",
            "10. Changes and law. We tell you 30 days before any material change takes effect. These terms are governed by the laws of Kuwait, and the courts of Kuwait have jurisdiction."
          ], ar: [
            '١. الأطراف. تطبيق AVO منصة تقنية تُشغّلها شركة AVO بيوتي المسجلة في دولة الكويت. الخدمة نفسها — القص، الصبغة، المنتجات — يقدّمها الصالون وهو الطرف المسؤول عنها. عند الحجز أو الدفع تتعاقدين مع الصالون، وتستخدمين AVO كوسيلة للدفع والحجز.',
            '٢. حسابك. الحساب شخصي ومرتبط برقم هاتفك. حافظي على كلمة المرور، وأبلغينا فوراً عند أي استخدام غير مصرّح به. عمر المستخدم ١٨ سنة أو أكثر، أو بموافقة وليّ الأمر.',
            '٣. الحجز والعربون. يُحجز الموعد بعربون يُخصم من محفظتك ويُحتسب من قيمة الخدمة. الإلغاء قبل ساعة أو أكثر يعيد العربون كاملاً؛ الإلغاء المتأخر أو عدم الحضور يعطي الصالون الحق في الاحتفاظ به.',
            '٤. الأسعار. الأسعار بالدينار الكويتي وتشمل الضرائب المطبّقة، ويحددها الصالون وقد تتغير. السعر المعروض لحظة التأكيد هو السعر الملزم.',
            '٥. المحفظة. رصيد المحفظة مدفوع مسبقاً للصالون المذكور فقط. ليس وديعة بنكية، ولا يخضع لضمان الودائع، ولا يُدرّ فوائد، ولا يُسحب نقداً. تُنفَّذ عمليات الدفع عبر مزوّد خدمات دفع مرخّص من بنك الكويت المركزي.',
            '٦. المنتجات. تُستلم منتجات المتجر من الصالون. المنتجات المفتوحة أو المستخدمة غير قابلة للإرجاع لأسباب صحية؛ أما المنتج التالف أو الخطأ فيُبدّل أو يُعاد كرصيد في المحفظة.',
            '٧. الاستخدام المقبول. لا يجوز إساءة استخدام التطبيق، أو محاولة الوصول إلى حسابات أخرى، أو استغلال المكافآت بشكل احتيالي. عند رصد إساءة قد يُعلَّق الحساب مع تسوية الرصيد المتبقي.',
            '٨. المسؤولية. AVO مسؤولة عن سلامة المنصة وعن سجل معاملاتك. أما نتيجة الخدمة داخل الصالون فمسؤولية الصالون. لا تتحمل AVO أي خسارة غير مباشرة، وتبقى مسؤوليتها في كل الأحوال بحدود المبالغ التي دفعتها خلال آخر ١٢ شهراً.',
            '٩. الشكاوى. راسلي الصالون أولاً من داخل التطبيق. إن لم تُحلّ الشكوى خلال ٧ أيام، تتدخل AVO للتوسط. أي شكوى بشأن الدفع تُراجع خلال ٣٠ يوماً من تاريخ العملية.',
            '١٠. التعديلات والقانون. نُبلغك بأي تعديل جوهري ٣٠ يوماً قبل نفاذه. تخضع هذه الشروط لقوانين دولة الكويت، والاختصاص لمحاكم الكويت.'
          ] } },
        { id: 'gpolicy', consent: true, scope: 'platform',
          title: { en: 'Privacy policy', ar: 'سياسة الخصوصية' },
          body: { en: [
            '1. Who controls your data. AVO Beauty Technologies (Kuwait) controls your platform account data. The salon you visit is a joint controller for your appointment and visit history with them.',
            '2. What we collect. Your name, phone number, appointment history, transaction and reward history, and basic device data for security. We never store card numbers — those stay with our licensed payment provider.',
            '3. Why we use it. To run your wallet and bookings, send receipts and reminders, prevent fraud, and meet anti-money-laundering obligations. Marketing offers are sent only with your consent and can be switched off at any time under Notifications.',
            '4. Who sees it. The salon you deal with sees your name, number and visit history. We do not sell your data and we do not share it with other salons on the platform.',
            '5. How long we keep it. Transaction records are kept for 7 years, as financial rules require. The rest of your account data is deleted within 30 days of a deletion request.',
            '6. Your rights. You can access, correct and export your data, delete your account, and withdraw consent for marketing messages. Do it from the Account page or write to privacy@avo.beauty.',
            '7. Security. Data is encrypted in transit and at rest, access is restricted, and every staff action on your record is written to an audit log. If an incident ever affects your data we will tell you and the regulator without delay.',
            '8. Where it lives. Data is stored in Kuwait or in data centres with equivalent protection, and any transfer abroad is covered by contractual safeguards.'
          ], ar: [
            '١. المتحكم بالبيانات. AVO بيوتي (الكويت) هي المتحكم بالبيانات الخاصة بحسابك على المنصة، والصالون متحكم مشترك في بيانات مواعيدك وزياراتك.',
            '٢. ما نجمعه. الاسم، رقم الهاتف، تاريخ المواعيد، سجل المعاملات والمكافآت، وبيانات تقنية أساسية للجهاز لأغراض الأمان. لا نحفظ أرقام البطاقات — تبقى عند مزوّد الدفع المرخّص.',
            '٣. لماذا نستخدمها. لتشغيل محفظتك وحجوزاتك، ولإرسال الإيصالات والتذكيرات، ولمنع الاحتيال، وللالتزام بمتطلبات مكافحة غسل الأموال. العروض التسويقية تُرسل بموافقتك فقط ويمكن إيقافها في أي وقت.',
            '٤. من يرى بياناتك. الصالون الذي تتعاملين معه يرى اسمك ورقمك وسجل زياراتك. لا نبيع بياناتك ولا نشاركها مع صالونات أخرى على المنصة.',
            '٥. مدة الحفظ. تُحفظ سجلات المعاملات ٧ سنوات كما تقتضي الأنظمة المالية. تُحذف بقية بيانات الحساب خلال ٣٠ يوماً من طلب الحذف.',
            '٦. حقوقك. لك حق الوصول إلى بياناتك وتصحيحها وتصديرها وحذف حسابك، وسحب موافقتك على الرسائل التسويقية. تُنفَّذ الطلبات من صفحة الحساب أو عبر privacy@avo.beauty.',
            '٧. الحماية. البيانات مشفّرة أثناء النقل والتخزين، والوصول إليها محدود ومسجّل في سجل تدقيق. أي حادثة تمسّ بياناتك تُبلَّغ لك وللجهة المختصة دون تأخير.',
            '٨. مكان التخزين. تُخزّن البيانات داخل الكويت أو في مراكز بيانات بمستوى حماية مكافئ، وأي نقل خارجي يخضع لضمانات تعاقدية.'
          ] } },
        { id: 'terms', consent: true, scope: 'wallet',
          title: { en: 'Wallet terms', ar: 'شروط المحفظة' },
          body: { en: [
            'Your wallet balance is prepaid credit for Amara Salon only. It cannot be spent at other salons on the AVO platform.',
            'Credit does not expire and carries no monthly fees. It cannot be transferred to another person or withdrawn as cash at the counter.',
            'Every top-up and payment appears in your activity with a reference number. Query anything within 30 days.',
            'AVO provides the technology; the salon provides the service. Your balance is not a bank deposit and is not covered by deposit insurance.'
          ], ar: [
            'رصيد المحفظة مدفوع مسبقاً لصالون أمارا فقط، ولا يُستخدم في صالونات أخرى على منصة AVO.',
            'الرصيد لا ينتهي ولا تُخصم منه رسوم شهرية. لا يمكن تحويله لشخص آخر أو سحبه نقداً.',
            'يظهر كل شحن وكل عملية دفع في سجل النشاط مع رقم مرجعي. راجعي أي عملية خلال ٣٠ يوماً.',
            'AVO مزوّد التقنية، والخدمة يقدّمها الصالون. الرصيد ليس وديعة بنكية ولا يخضع لضمان الودائع.'
          ] } },
        { id: 'refund', consent: true, scope: 'wallet',
          title: { en: 'Refunds & cancellation', ar: 'الاسترجاع والإلغاء' },
          body: { en: [
            'Cancel an appointment an hour or more ahead and your deposit returns to your wallet within minutes, automatically.',
            'Cancel with less than an hour to go, or miss the slot, and the salon may keep the deposit.',
            'If you were charged the wrong amount, salon staff can void the charge for 15 minutes. After that the salon can reimburse you from their dashboard at any time.',
            'Every refund is returned as wallet credit. AVO does not pay refunds in cash or back to your card — the money stays in your wallet and is ready to use on your next visit.'
          ], ar: [
            'إلغاء الموعد قبل ساعة أو أكثر: يعود العربون كاملاً إلى محفظتك خلال دقائق.',
            'الإلغاء قبل أقل من ساعة أو عدم الحضور: يحق للصالون الاحتفاظ بالعربون.',
            'إذا خُصم مبلغ خاطئ، يستطيع موظف الصالون إلغاء العملية خلال ١٥ دقيقة، أو تعويضك من لوحة التحكم في أي وقت.',
            'كل مبلغ مسترجع يعود كرصيد في محفظتك. لا يتم الاسترجاع نقداً أو إلى البطاقة — يبقى المبلغ في محفظتك جاهزاً لزيارتك القادمة.'
          ] } },
        { id: 'bonus', consent: false, scope: 'wallet',
          title: { en: 'How bonuses work', ar: 'كيف تعمل المكافآت' },
          body: { en: [
            'Top-up bonuses and tier rewards are funded by Amara Salon, not by AVO. The salon can change bonus rates and tier thresholds whenever it likes.',
            'A bonus lands the moment your top-up succeeds and behaves like ordinary credit.',
            'Changing the tier rules never reduces credit already in your wallet.'
          ], ar: [
            'مكافأة الشحن ممولة من الصالون وليست من AVO، ويمكن للصالون تعديل نسبها أو شروط المستويات في أي وقت.',
            'تُضاف المكافأة فور نجاح الشحن وتُعامل كرصيد عادي.',
            'تغيير قواعد المستويات لا يؤثر على رصيدك الحالي.'
          ] } },
        { id: 'expiry', consent: false, scope: 'wallet',
          title: { en: 'Does my credit expire?', ar: 'هل ينتهي رصيدي؟' },
          body: { en: [
            'No. Wallet credit does not expire, and there are no dormancy or monthly fees taken from it.',
            'Tier bonuses are added as ordinary credit, so they do not expire either.',
            'If the salon closes or leaves AVO, you are told 60 days ahead and the salon must settle any remaining balance with you.',
            'A stamp card resets only after you claim its reward — that never touches your wallet balance.'
          ], ar: [
            'لا. رصيد محفظتك لا ينتهي ولا يُخصم منه أي رسوم سكون أو رسوم شهرية.',
            'مكافآت المستويات تُضاف كرصيد عادي، وهي أيضاً لا تنتهي.',
            'إذا أغلق الصالون أو أوقف خدمته على AVO، نُبلغك قبل ٦٠ يوماً وعليه تسوية أي رصيد متبقٍ معك.',
            'بطاقة الأختام تُصفَّر بعد استلام المكافأة فقط — وهذا لا يمسّ رصيد محفظتك.'
          ] } },
        { id: 'privacy', consent: true, scope: 'wallet',
          title: { en: 'Privacy & your data', ar: 'الخصوصية وبياناتك' },
          body: { en: [
            'We hold your name, phone number and your transaction history with this salon. Nothing more.',
            'Your number is used to send WhatsApp receipts and appointment confirmations. Turn those off under Notifications.',
            'We do not sell your data. You can request a copy, or delete your account, from this page.'
          ], ar: [
            'نحفظ اسمك ورقم هاتفك وسجل معاملاتك مع هذا الصالون فقط.',
            'رقمك يُستخدم لإرسال الإيصالات والتأكيدات على واتساب. يمكنك إيقافها من الإشعارات.',
            'لا نبيع بياناتك. يمكنك طلب نسخة أو حذف حسابك من هذه الصفحة.'
          ] } }
      ];
      return {
        published: { version: 3, effectiveFrom: '2026-07-01', publishedAt: '2026-06-01T09:00', publishedBy: 'Yousef · Owner', docs: JSON.parse(JSON.stringify(docs)) },
        draft: { docs: JSON.parse(JSON.stringify(docs)) },
        reviewedBy: '', reviewNote: 'Awaiting counsel + PSP sign-off before launch.'
      };
    })(),
    /* ---- support: the channels and topics the wallet's contact form shows.
       Owned by AVO (Owner Console -> Policies -> Support) so a salon cannot
       point customers at an unmonitored number. `route` decides who the
       message lands with: 'salon' = the branch, 'avo' = platform support. ---- */
    support: {
      channels: {
        whatsapp: '+965 9008 4408',
        email: 'help@avobeauty.com',
        hoursEn: 'Saturday to Thursday, 10:00 - 20:00',
        hoursAr: 'السبت إلى الخميس، ١٠:٠٠ - ٢٠:٠٠',
        replyEn: 'Most messages are answered the same working day.',
        replyAr: 'نجيب على معظم الرسائل في نفس يوم العمل.'
      },
      topics: [
        { id: 'wallet', route: 'avo', en: 'Wallet, top-ups or refunds', ar: 'المحفظة أو الشحن أو الاسترجاع' },
        { id: 'charge', route: 'avo', en: 'A charge I do not recognise', ar: 'خصم لا أعرفه' },
        { id: 'booking', route: 'salon', en: 'An appointment', ar: 'موعد' },
        { id: 'visit', route: 'salon', en: 'My visit or the service', ar: 'زيارتي أو الخدمة' },
        { id: 'account', route: 'avo', en: 'My account or my data', ar: 'حسابي أو بياناتي' },
        { id: 'other', route: 'avo', en: 'Something else', ar: 'شيء آخر' }
      ],
      tickets: [
        { id: 'SUP-40219', topicId: 'charge', member: 'Dana Al-Roumi', message: 'I was charged 12.500 KD on Sunday but I only had a blow-dry.', ref: 'AVO-77219', via: 'wa', route: 'avo', at: '2026-08-06T18:40', status: 'closed' },
        { id: 'SUP-40224', topicId: 'booking', member: 'Noura A.', message: 'Can I move Saturday to the Salmiya branch instead?', ref: '', via: 'wa', route: 'salon', at: '2026-08-08T11:02', status: 'open' }
      ]
    },
    clockOffsetMin: 0,
    updatedAt: null
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function load() {
    var raw = null;
    try { raw = window.localStorage.getItem(KEY); } catch (e) { raw = null; }
    if (!raw) return mem ? clone(mem) : clone(SEED);
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return clone(SEED); }
    if (!parsed || parsed.version !== SEED.version) return clone(SEED);
    var merged = clone(SEED);
    for (var k in parsed) if (Object.prototype.hasOwnProperty.call(parsed, k)) merged[k] = parsed[k];
    return merged;
  }

  function save(next, reason) {
    next.updatedAt = new Date().toISOString();
    mem = clone(next);
    try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* memory only */ }
    subs.slice().forEach(function (fn) { try { fn(clone(next), reason || ''); } catch (e) {} });
    return clone(next);
  }

  function edit(fn, reason) { var st = load(); fn(st); return save(st, reason); }

  function mins(hhmm) {
    var p = String(hhmm || '0:00').split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  var API = {
    KEY: KEY,
    REWARDS: REWARDS,

    get: function () { return load(); },

    subscribe: function (fn) {
      subs.push(fn);
      return function () { subs = subs.filter(function (f) { return f !== fn; }); };
    },

    /* ---- clock. Offset lets a demo sit inside or outside a window
       without faking the "live" flag — the countdown is always derived. ---- */
    now: function () {
      var off = load().clockOffsetMin || 0;
      return new Date(Date.now() + off * 60000);
    },
    setClockOffsetMin: function (n) { return edit(function (s) { s.clockOffsetMin = n; }, 'clock'); },

    /* Aligns the clock so that `hhmm` is the current time-of-day today. */
    offsetForTimeOfDay: function (hhmm) {
      var real = new Date();
      var target = mins(hhmm);
      var nowMin = real.getHours() * 60 + real.getMinutes();
      return target - nowMin;
    },

    setBranches: function (list) { return edit(function (s) { s.branches = list; }, 'branches'); },
    branchName: function (id, ar) {
      var b = load().branches.filter(function (x) { return x.id === id; })[0];
      if (!b) return id === 'all' ? (ar ? 'كل الفروع' : 'All branches') : id;
      return ar ? b.nameAr : b.name;
    },
    branchIdByName: function (name) {
      var b = load().branches.filter(function (x) { return x.name === name; })[0];
      return b ? b.id : 'all';
    },
    rewardLabel: function (key, ar) {
      var r = REWARDS[key] || REWARDS.none;
      return ar ? r.ar : r.en;
    },

    /* ---- branch boosts ---- */
    boostFor: function (branchId) {
      var s = load();
      return s.boosts[branchId] || { visit: 1, topup: 0, stamp: 1 };
    },
    publishBoosts: function (boosts, by) {
      return edit(function (s) {
        s.boosts = boosts;
        s.boostsPublishedAt = new Date().toISOString();
        s.boostsPublishedBy = by || '';
      }, 'boosts');
    },

    /* ---- happy hours ---- */
    setHappy: function (list) { return edit(function (s) { s.happy = list; }, 'happy'); },
    addHappy: function (win) {
      var row = null;
      edit(function (s) {
        row = Object.assign({ id: 'h' + Date.now(), on: true, notify: true }, win);
        s.happy = s.happy.concat([row]);
      }, 'happy');
      return row;
    },
    patchHappy: function (id, patch) {
      return edit(function (s) {
        s.happy = s.happy.map(function (h) { return h.id === id ? Object.assign({}, h, patch) : h; });
      }, 'happy');
    },
    removeHappy: function (id) {
      return edit(function (s) {
        s.happy = s.happy.filter(function (h) { return h.id !== id; });
      }, 'happy');
    },

    /* Resolves windows against a real clock: what is live right now, how
       long it has left, and what opens next. No stored "live" flag. */
    resolveHappy: function (nowDate, branchId) {
      var s = load();
      var now = nowDate || API.now();
      var day = now.getDay();
      var nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
      var live = null, next = null, nextIn = Infinity;
      s.happy.forEach(function (h) {
        if (!h.on) return;
        if (branchId && branchId !== 'all' && h.branchId !== branchId && h.branchId !== 'all') return;
        var from = mins(h.from), to = mins(h.to);
        if (h.days.indexOf(day) !== -1 && nowMin >= from && nowMin < to) {
          var msLeft = Math.round((to - nowMin) * 60000);
          if (!live || msLeft < live.msLeft) live = Object.assign({}, h, { msLeft: msLeft, endsAt: h.to });
        }
        for (var d = 0; d < 8; d++) {
          var dow = (day + d) % 7;
          if (h.days.indexOf(dow) === -1) continue;
          var startIn = d * 1440 + from - nowMin;
          if (startIn <= 0) continue;
          if (startIn < nextIn) { nextIn = startIn; next = Object.assign({}, h, { startsInMs: Math.round(startIn * 60000), inDays: d }); }
          break;
        }
      });
      return { live: live, next: next, at: now.toISOString() };
    },

    countdown: function (ms, ar) {
      if (ms == null || ms < 0) ms = 0;
      var total = Math.floor(ms / 1000);
      var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
      var num = function (n) { return ar ? String(n).replace(/[0-9]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'[+d]; }) : String(n); };
      if (h > 0) return num(h) + (ar ? ' س ' : 'h ') + num(pad(m)) + (ar ? ' د' : 'm');
      if (m > 0) return num(m) + (ar ? ' د ' : 'm ') + num(pad(sec)) + (ar ? ' ث' : 's');
      return num(sec) + (ar ? ' ث' : 's');
    },

    /* ---- campaigns: merchant submits, AVO approves, then it sends ---- */
    submitCampaign: function (c) {
      var row = null;
      edit(function (s) {
        row = Object.assign({
          id: 'c-' + Date.now(), status: s.policy.requireApproval ? 'pending' : 'approved',
          submittedAt: new Date().toISOString(), decidedBy: '', decidedAt: '', note: '', result: ''
        }, c);
        s.campaigns = [row].concat(s.campaigns);
      }, 'campaign');
      return row;
    },
    decideCampaign: function (id, status, note, by) {
      return edit(function (s) {
        s.campaigns = s.campaigns.map(function (c) {
          if (c.id !== id) return c;
          return Object.assign({}, c, {
            status: status, note: note || '', decidedBy: by || 'AVO', decidedAt: new Date().toISOString()
          });
        });
      }, 'campaign');
    },
    withdrawCampaign: function (id) {
      return edit(function (s) {
        s.campaigns = s.campaigns.filter(function (c) { return c.id !== id; });
      }, 'campaign');
    },
    setPolicy: function (patch) {
      return edit(function (s) { s.policy = Object.assign({}, s.policy, patch); }, 'policy');
    },
    pendingCount: function () {
      return load().campaigns.filter(function (c) { return c.status === 'pending'; }).length;
    },

    /* ---- staff authority (merchant-controlled, read by the scanner) ---- */
    setTeam: function (list) { return edit(function (s) { s.team = list; }, 'team'); },
    setPerm: function (staffId, key, val) {
      return edit(function (s) {
        s.team = s.team.map(function (t) {
          return t.id === staffId ? Object.assign({}, t, { perms: Object.assign({}, t.perms, { [key]: val }) }) : t;
        });
      }, 'team');
    },
    staff: function (handleOrId) {
      var s = load();
      return s.team.filter(function (t) { return t.id === handleOrId || t.handle === handleOrId; })[0] || null;
    },
    can: function (handleOrId, key) {
      var t = API.staff(handleOrId);
      return !!(t && t.perms && t.perms[key]);
    },

    /* ---- legal documents: drafted by AVO, published to every wallet ----
       The customer app renders `policies.published.docs` — it holds no copy of
       its own. Editing touches the draft only; nothing reaches a phone until
       publishPolicies() copies draft over published and stamps a version. */
    policyDocs: function (lang, which) {
      var p = load().policies[which === 'draft' ? 'draft' : 'published'];
      var ar = lang === 'ar';
      return p.docs.map(function (d) {
        return { id: d.id, title: ar ? d.title.ar : d.title.en, body: (ar ? d.body.ar : d.body.en) || [], consent: !!d.consent, scope: d.scope };
      });
    },
    policyMeta: function () {
      var p = load().policies;
      return {
        version: p.published.version, effectiveFrom: p.published.effectiveFrom,
        publishedAt: p.published.publishedAt, publishedBy: p.published.publishedBy,
        reviewNote: p.reviewNote,
        dirty: JSON.stringify(p.draft.docs) !== JSON.stringify(p.published.docs)
      };
    },
    setPolicyClause: function (docId, lang, index, text) {
      return edit(function (s) {
        s.policies.draft.docs = s.policies.draft.docs.map(function (d) {
          if (d.id !== docId) return d;
          var body = Object.assign({}, d.body);
          body[lang] = body[lang].slice();
          body[lang][index] = text;
          return Object.assign({}, d, { body: body });
        });
      }, 'policies');
    },
    addPolicyClause: function (docId, lang) {
      return edit(function (s) {
        s.policies.draft.docs = s.policies.draft.docs.map(function (d) {
          if (d.id !== docId) return d;
          var body = Object.assign({}, d.body);
          body[lang] = (body[lang] || []).concat(['']);
          return Object.assign({}, d, { body: body });
        });
      }, 'policies');
    },
    removePolicyClause: function (docId, lang, index) {
      return edit(function (s) {
        s.policies.draft.docs = s.policies.draft.docs.map(function (d) {
          if (d.id !== docId) return d;
          var body = Object.assign({}, d.body);
          body[lang] = body[lang].filter(function (_, i) { return i !== index; });
          return Object.assign({}, d, { body: body });
        });
      }, 'policies');
    },
    setPolicyTitle: function (docId, lang, text) {
      return edit(function (s) {
        s.policies.draft.docs = s.policies.draft.docs.map(function (d) {
          return d.id === docId ? Object.assign({}, d, { title: Object.assign({}, d.title, { [lang]: text }) }) : d;
        });
      }, 'policies');
    },
    setPolicyConsent: function (docId, val) {
      return edit(function (s) {
        s.policies.draft.docs = s.policies.draft.docs.map(function (d) {
          return d.id === docId ? Object.assign({}, d, { consent: !!val }) : d;
        });
      }, 'policies');
    },
    addPolicyDoc: function (titleEn) {
      var id = 'doc' + Date.now();
      edit(function (s) {
        s.policies.draft.docs = s.policies.draft.docs.concat([{
          id: id, consent: false, scope: 'platform',
          title: { en: titleEn || 'Untitled document', ar: '' },
          body: { en: [''], ar: [''] }
        }]);
      }, 'policies');
      return id;
    },
    removePolicyDoc: function (docId) {
      return edit(function (s) {
        s.policies.draft.docs = s.policies.draft.docs.filter(function (d) { return d.id !== docId; });
      }, 'policies');
    },
    movePolicyDoc: function (docId, dir) {
      return edit(function (s) {
        var arr = s.policies.draft.docs.slice();
        var i = arr.findIndex(function (d) { return d.id === docId; });
        var j = i + dir;
        if (i < 0 || j < 0 || j >= arr.length) return;
        var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        s.policies.draft.docs = arr;
      }, 'policies');
    },
    publishPolicies: function (effectiveFrom, by) {
      return edit(function (s) {
        s.policies.published = {
          version: s.policies.published.version + 1,
          effectiveFrom: effectiveFrom || s.policies.published.effectiveFrom,
          publishedAt: new Date().toISOString().slice(0, 16),
          publishedBy: by || 'AVO',
          docs: JSON.parse(JSON.stringify(s.policies.draft.docs))
        };
      }, 'policies');
    },
    setPolicyReview: function (note, by) {
      return edit(function (s) {
        s.policies.reviewNote = note;
        if (by !== undefined) s.policies.reviewedBy = by;
      }, 'policies');
    },
    discardPolicyDraft: function () {
      return edit(function (s) {
        s.policies.draft = { docs: JSON.parse(JSON.stringify(s.policies.published.docs)) };
      }, 'policies');
    },

    /* ---- salon social channels ---- */
    SOCIAL_ICONS: {
      instagram: 'M7 3.5h10a3.5 3.5 0 0 1 3.5 3.5v10a3.5 3.5 0 0 1-3.5 3.5H7A3.5 3.5 0 0 1 3.5 17V7A3.5 3.5 0 0 1 7 3.5ZM12 8.2a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6ZM17.1 6.7h.01',
      tiktok: 'M14 3.5v10.2a3.4 3.4 0 1 1-2.7-3.33M14 3.5c.45 2.3 1.95 3.6 4.1 3.8',
      snapchat: 'M12 3.2c3 0 4.6 2 4.6 4.6 0 .9-.1 1.7.3 2 .5.4 1.4 0 1.7.5.3.6-.9 1.2-1.7 1.6-.5.3.4 1.9 2 2.4.5.2.3.8-.4 1-1 .3-1.6.2-1.9.6-.2.3-.1.9-.7.9-1 0-1.8-.4-2.8.3-.8.6-1.4 1.1-2.6 1.1s-1.8-.5-2.6-1.1c-1-.7-1.8-.3-2.8-.3-.6 0-.5-.6-.7-.9-.3-.4-.9-.3-1.9-.6-.7-.2-.9-.8-.4-1 1.6-.5 2.5-2.1 2-2.4-.8-.4-2-1-1.7-1.6.3-.5 1.2-.1 1.7-.5.4-.3.3-1.1.3-2C7.4 5.2 9 3.2 12 3.2Z',
      whatsapp: 'M20 12a8 8 0 0 1-11.9 7L4 20l1.1-4A8 8 0 1 1 20 12ZM9.2 8.9c.4-.2.9 0 1 .4l.6 1.3-.7.9c.5 1 1.3 1.8 2.3 2.2l.9-.7 1.3.6c.4.2.6.6.4 1-.3.8-1.2 1.2-2 1-2.4-.6-4.3-2.5-4.9-4.9-.2-.8.3-1.6 1.1-1.8Z'
    },
    /* the link is always derived from the handle — a salon that edits its
       handle can never end up with the icon pointing at a dead profile. */
    socialUrl: function (id, handle) {
      var h = String(handle || '').trim();
      if (!h) return '';
      var name = h.replace(/^@/, '');
      if (id === 'instagram') return 'https://instagram.com/' + name;
      if (id === 'tiktok') return 'https://tiktok.com/@' + name;
      if (id === 'snapchat') return 'https://snapchat.com/add/' + name;
      if (id === 'whatsapp') return 'https://wa.me/' + h.replace(/\D/g, '');
      return /^https?:/i.test(h) ? h : 'https://' + name;
    },
    socialLinks: function (opts) {
      var all = (load().salon.social || []);
      var list = (opts && opts.all) ? all : all.filter(function (x) { return x.on && x.handle; });
      var icons = API.SOCIAL_ICONS;
      return list.map(function (x) {
        return { id: x.id, label: x.label, handle: x.handle, url: API.socialUrl(x.id, x.handle), on: !!x.on, d: icons[x.id] || '' };
      });
    },
    setSocial: function (id, patch) {
      return edit(function (s) {
        s.salon.social = (s.salon.social || []).map(function (x) {
          return x.id === id ? Object.assign({}, x, patch) : x;
        });
      }, 'social');
    },

    /* ---- support / contact ---- */
    supportConfig: function (lang) {
      var sp = load().support;
      var ar = lang === 'ar';
      return {
        whatsapp: sp.channels.whatsapp,
        email: sp.channels.email,
        hours: ar ? sp.channels.hoursAr : sp.channels.hoursEn,
        reply: ar ? sp.channels.replyAr : sp.channels.replyEn,
        topics: sp.topics.map(function (tp) {
          return { id: tp.id, label: ar ? tp.ar : tp.en, route: tp.route };
        })
      };
    },
    setSupportChannel: function (key, val) {
      return edit(function (s) { s.support.channels[key] = val; }, 'support');
    },
    setSupportTopic: function (id, lang, text) {
      return edit(function (s) {
        s.support.topics = s.support.topics.map(function (tp) {
          return tp.id === id ? Object.assign({}, tp, { [lang]: text }) : tp;
        });
      }, 'support');
    },
    setSupportTopicRoute: function (id, route) {
      return edit(function (s) {
        s.support.topics = s.support.topics.map(function (tp) {
          return tp.id === id ? Object.assign({}, tp, { route: route }) : tp;
        });
      }, 'support');
    },
    addSupportTopic: function (en) {
      var id = 'tp' + Date.now();
      edit(function (s) {
        s.support.topics = s.support.topics.concat([{ id: id, route: 'avo', en: en || 'New topic', ar: '' }]);
      }, 'support');
      return id;
    },
    removeSupportTopic: function (id) {
      return edit(function (s) {
        s.support.topics = s.support.topics.filter(function (tp) { return tp.id !== id; });
      }, 'support');
    },
    moveSupportTopic: function (id, dir) {
      return edit(function (s) {
        var arr = s.support.topics.slice();
        var i = arr.findIndex(function (tp) { return tp.id === id; });
        var j = i + dir;
        if (i < 0 || j < 0 || j >= arr.length) return;
        var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        s.support.topics = arr;
      }, 'support');
    },
    /* The wallet calls this on send. Real build: POST /v1/support/tickets —
       the id is the customer's reference, the route decides the queue. */
    submitTicket: function (t) {
      var sp = load().support;
      var topic = sp.topics.filter(function (x) { return x.id === t.topicId; })[0];
      var id = 'SUP-' + String(40000 + Math.floor(Math.random() * 9999));
      var row = {
        id: id, topicId: t.topicId || 'other', member: t.member || '',
        message: t.message || '', ref: t.ref || '', via: t.via || 'wa',
        route: topic ? topic.route : 'avo',
        at: new Date().toISOString().slice(0, 16), status: 'open'
      };
      edit(function (s) { s.support.tickets = [row].concat(s.support.tickets); }, 'support');
      return row;
    },
    tickets: function () { return load().support.tickets; },
    setTicketStatus: function (id, status) {
      return edit(function (s) {
        s.support.tickets = s.support.tickets.map(function (x) {
          return x.id === id ? Object.assign({}, x, { status: status }) : x;
        });
      }, 'support');
    },

    reset: function () {
      try { window.localStorage.removeItem(KEY); } catch (e) {}
      mem = null;
      return save(clone(SEED), 'reset');
    }
  };

  try {
    window.addEventListener('storage', function (e) {
      if (e.key !== KEY) return;
      var st = load();
      subs.slice().forEach(function (fn) { try { fn(clone(st), 'remote'); } catch (err) {} });
    });
  } catch (e) {}

  window.AVOPromotions = API;
})();
