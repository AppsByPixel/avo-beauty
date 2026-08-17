/**
 * THE PUBLISHED LEGAL SET AND THE SUPPORT CONFIGURATION.
 *
 * NON-NEGOTIABLE #10: "The customer app holds no legal copy. It renders the
 * published policy set from the API and stamps the version." This file is where
 * that copy actually lives, and it is the reason the wallet's Terms screen has
 * anything on it.
 *
 * GENERATED FROM design/avo-promotions.js, VERBATIM. Both languages, every
 * clause, in array order. Not paraphrased and not abridged — CLAUDE.md § How to
 * work: "Keep the copy verbatim. Both languages. Product copy is written; do not
 * paraphrase." That matters more here than anywhere else in the product: this
 * is the text a customer is held to, `consent: true` documents block account
 * creation until she accepts them, and the version stamped against her record is
 * a claim about which words she agreed to. Rewording a clause silently changes
 * what a stored consent means.
 *
 * The mock (packages/mock) publishes an ABRIDGED three-document set and says so.
 * This is the full seven.
 *
 * WHAT IS STILL OWED, AND IT IS NOT CODE. design/avo-promotions.js carries
 * `reviewNote: "Awaiting counsel + PSP sign-off before launch."`, and CLAUDE.md
 * lists "CBK/PSP selection and counsel sign-off on the legal set" among the
 * decisions that belong to the client. Seeding this text is not the same as it
 * having been approved.
 */

export interface LegalDocSeed {
  id: string;
  scope: 'platform' | 'wallet';
  consent: boolean;
  title: { en: string; ar: string };
  body: { en: string[]; ar: string[] };
}

export interface LegalSetSeed {
  version: number;
  effectiveFrom: string;
  publishedAt: string;
  publishedBy: string;
  docs: LegalDocSeed[];
}

/** design/avo-promotions.js § policies.published. */
export const PUBLISHED_LEGAL_SET: LegalSetSeed = {
  "version": 3,
  "effectiveFrom": "2026-07-01",
  "publishedAt": "2026-06-01T09:00",
  "publishedBy": "Yousef · Owner",
  "docs": [
    {
      "id": "gterms",
      "consent": true,
      "scope": "platform",
      "title": {
        "en": "Terms & conditions",
        "ar": "الشروط والأحكام"
      },
      "body": {
        "en": [
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
        ],
        "ar": [
          "١. الأطراف. تطبيق AVO منصة تقنية تُشغّلها شركة AVO بيوتي المسجلة في دولة الكويت. الخدمة نفسها — القص، الصبغة، المنتجات — يقدّمها الصالون وهو الطرف المسؤول عنها. عند الحجز أو الدفع تتعاقدين مع الصالون، وتستخدمين AVO كوسيلة للدفع والحجز.",
          "٢. حسابك. الحساب شخصي ومرتبط برقم هاتفك. حافظي على كلمة المرور، وأبلغينا فوراً عند أي استخدام غير مصرّح به. عمر المستخدم ١٨ سنة أو أكثر، أو بموافقة وليّ الأمر.",
          "٣. الحجز والعربون. يُحجز الموعد بعربون يُخصم من محفظتك ويُحتسب من قيمة الخدمة. الإلغاء قبل ساعة أو أكثر يعيد العربون كاملاً؛ الإلغاء المتأخر أو عدم الحضور يعطي الصالون الحق في الاحتفاظ به.",
          "٤. الأسعار. الأسعار بالدينار الكويتي وتشمل الضرائب المطبّقة، ويحددها الصالون وقد تتغير. السعر المعروض لحظة التأكيد هو السعر الملزم.",
          "٥. المحفظة. رصيد المحفظة مدفوع مسبقاً للصالون المذكور فقط. ليس وديعة بنكية، ولا يخضع لضمان الودائع، ولا يُدرّ فوائد، ولا يُسحب نقداً. تُنفَّذ عمليات الدفع عبر مزوّد خدمات دفع مرخّص من بنك الكويت المركزي.",
          "٦. المنتجات. تُستلم منتجات المتجر من الصالون. المنتجات المفتوحة أو المستخدمة غير قابلة للإرجاع لأسباب صحية؛ أما المنتج التالف أو الخطأ فيُبدّل أو يُعاد كرصيد في المحفظة.",
          "٧. الاستخدام المقبول. لا يجوز إساءة استخدام التطبيق، أو محاولة الوصول إلى حسابات أخرى، أو استغلال المكافآت بشكل احتيالي. عند رصد إساءة قد يُعلَّق الحساب مع تسوية الرصيد المتبقي.",
          "٨. المسؤولية. AVO مسؤولة عن سلامة المنصة وعن سجل معاملاتك. أما نتيجة الخدمة داخل الصالون فمسؤولية الصالون. لا تتحمل AVO أي خسارة غير مباشرة، وتبقى مسؤوليتها في كل الأحوال بحدود المبالغ التي دفعتها خلال آخر ١٢ شهراً.",
          "٩. الشكاوى. راسلي الصالون أولاً من داخل التطبيق. إن لم تُحلّ الشكوى خلال ٧ أيام، تتدخل AVO للتوسط. أي شكوى بشأن الدفع تُراجع خلال ٣٠ يوماً من تاريخ العملية.",
          "١٠. التعديلات والقانون. نُبلغك بأي تعديل جوهري ٣٠ يوماً قبل نفاذه. تخضع هذه الشروط لقوانين دولة الكويت، والاختصاص لمحاكم الكويت."
        ]
      }
    },
    {
      "id": "gpolicy",
      "consent": true,
      "scope": "platform",
      "title": {
        "en": "Privacy policy",
        "ar": "سياسة الخصوصية"
      },
      "body": {
        "en": [
          "1. Who controls your data. AVO Beauty Technologies (Kuwait) controls your platform account data. The salon you visit is a joint controller for your appointment and visit history with them.",
          "2. What we collect. Your name, phone number, appointment history, transaction and reward history, and basic device data for security. We never store card numbers — those stay with our licensed payment provider.",
          "3. Why we use it. To run your wallet and bookings, send receipts and reminders, prevent fraud, and meet anti-money-laundering obligations. Marketing offers are sent only with your consent and can be switched off at any time under Notifications.",
          "4. Who sees it. The salon you deal with sees your name, number and visit history. We do not sell your data and we do not share it with other salons on the platform.",
          "5. How long we keep it. Transaction records are kept for 7 years, as financial rules require. The rest of your account data is deleted within 30 days of a deletion request.",
          "6. Your rights. You can access, correct and export your data, delete your account, and withdraw consent for marketing messages. Do it from the Account page or write to privacy@avo.beauty.",
          "7. Security. Data is encrypted in transit and at rest, access is restricted, and every staff action on your record is written to an audit log. If an incident ever affects your data we will tell you and the regulator without delay.",
          "8. Where it lives. Data is stored in Kuwait or in data centres with equivalent protection, and any transfer abroad is covered by contractual safeguards."
        ],
        "ar": [
          "١. المتحكم بالبيانات. AVO بيوتي (الكويت) هي المتحكم بالبيانات الخاصة بحسابك على المنصة، والصالون متحكم مشترك في بيانات مواعيدك وزياراتك.",
          "٢. ما نجمعه. الاسم، رقم الهاتف، تاريخ المواعيد، سجل المعاملات والمكافآت، وبيانات تقنية أساسية للجهاز لأغراض الأمان. لا نحفظ أرقام البطاقات — تبقى عند مزوّد الدفع المرخّص.",
          "٣. لماذا نستخدمها. لتشغيل محفظتك وحجوزاتك، ولإرسال الإيصالات والتذكيرات، ولمنع الاحتيال، وللالتزام بمتطلبات مكافحة غسل الأموال. العروض التسويقية تُرسل بموافقتك فقط ويمكن إيقافها في أي وقت.",
          "٤. من يرى بياناتك. الصالون الذي تتعاملين معه يرى اسمك ورقمك وسجل زياراتك. لا نبيع بياناتك ولا نشاركها مع صالونات أخرى على المنصة.",
          "٥. مدة الحفظ. تُحفظ سجلات المعاملات ٧ سنوات كما تقتضي الأنظمة المالية. تُحذف بقية بيانات الحساب خلال ٣٠ يوماً من طلب الحذف.",
          "٦. حقوقك. لك حق الوصول إلى بياناتك وتصحيحها وتصديرها وحذف حسابك، وسحب موافقتك على الرسائل التسويقية. تُنفَّذ الطلبات من صفحة الحساب أو عبر privacy@avo.beauty.",
          "٧. الحماية. البيانات مشفّرة أثناء النقل والتخزين، والوصول إليها محدود ومسجّل في سجل تدقيق. أي حادثة تمسّ بياناتك تُبلَّغ لك وللجهة المختصة دون تأخير.",
          "٨. مكان التخزين. تُخزّن البيانات داخل الكويت أو في مراكز بيانات بمستوى حماية مكافئ، وأي نقل خارجي يخضع لضمانات تعاقدية."
        ]
      }
    },
    {
      "id": "terms",
      "consent": true,
      "scope": "wallet",
      "title": {
        "en": "Wallet terms",
        "ar": "شروط المحفظة"
      },
      "body": {
        "en": [
          "Your wallet balance is prepaid credit for Amara Salon only. It cannot be spent at other salons on the AVO platform.",
          "Credit does not expire and carries no monthly fees. It cannot be transferred to another person or withdrawn as cash at the counter.",
          "Every top-up and payment appears in your activity with a reference number. Query anything within 30 days.",
          "AVO provides the technology; the salon provides the service. Your balance is not a bank deposit and is not covered by deposit insurance."
        ],
        "ar": [
          "رصيد المحفظة مدفوع مسبقاً لصالون أمارا فقط، ولا يُستخدم في صالونات أخرى على منصة AVO.",
          "الرصيد لا ينتهي ولا تُخصم منه رسوم شهرية. لا يمكن تحويله لشخص آخر أو سحبه نقداً.",
          "يظهر كل شحن وكل عملية دفع في سجل النشاط مع رقم مرجعي. راجعي أي عملية خلال ٣٠ يوماً.",
          "AVO مزوّد التقنية، والخدمة يقدّمها الصالون. الرصيد ليس وديعة بنكية ولا يخضع لضمان الودائع."
        ]
      }
    },
    {
      "id": "refund",
      "consent": true,
      "scope": "wallet",
      "title": {
        "en": "Refunds & cancellation",
        "ar": "الاسترجاع والإلغاء"
      },
      "body": {
        "en": [
          "Cancel an appointment an hour or more ahead and your deposit returns to your wallet within minutes, automatically.",
          "Cancel with less than an hour to go, or miss the slot, and the salon may keep the deposit.",
          "If you were charged the wrong amount, salon staff can void the charge for 15 minutes. After that the salon can reimburse you from their dashboard at any time.",
          "Every refund is returned as wallet credit. AVO does not pay refunds in cash or back to your card — the money stays in your wallet and is ready to use on your next visit."
        ],
        "ar": [
          "إلغاء الموعد قبل ساعة أو أكثر: يعود العربون كاملاً إلى محفظتك خلال دقائق.",
          "الإلغاء قبل أقل من ساعة أو عدم الحضور: يحق للصالون الاحتفاظ بالعربون.",
          "إذا خُصم مبلغ خاطئ، يستطيع موظف الصالون إلغاء العملية خلال ١٥ دقيقة، أو تعويضك من لوحة التحكم في أي وقت.",
          "كل مبلغ مسترجع يعود كرصيد في محفظتك. لا يتم الاسترجاع نقداً أو إلى البطاقة — يبقى المبلغ في محفظتك جاهزاً لزيارتك القادمة."
        ]
      }
    },
    {
      "id": "bonus",
      "consent": false,
      "scope": "wallet",
      "title": {
        "en": "How bonuses work",
        "ar": "كيف تعمل المكافآت"
      },
      "body": {
        "en": [
          "Top-up bonuses and tier rewards are funded by Amara Salon, not by AVO. The salon can change bonus rates and tier thresholds whenever it likes.",
          "A bonus lands the moment your top-up succeeds and behaves like ordinary credit.",
          "Changing the tier rules never reduces credit already in your wallet."
        ],
        "ar": [
          "مكافأة الشحن ممولة من الصالون وليست من AVO، ويمكن للصالون تعديل نسبها أو شروط المستويات في أي وقت.",
          "تُضاف المكافأة فور نجاح الشحن وتُعامل كرصيد عادي.",
          "تغيير قواعد المستويات لا يؤثر على رصيدك الحالي."
        ]
      }
    },
    {
      "id": "expiry",
      "consent": false,
      "scope": "wallet",
      "title": {
        "en": "Does my credit expire?",
        "ar": "هل ينتهي رصيدي؟"
      },
      "body": {
        "en": [
          "No. Wallet credit does not expire, and there are no dormancy or monthly fees taken from it.",
          "Tier bonuses are added as ordinary credit, so they do not expire either.",
          "If the salon closes or leaves AVO, you are told 60 days ahead and the salon must settle any remaining balance with you.",
          "A stamp card resets only after you claim its reward — that never touches your wallet balance."
        ],
        "ar": [
          "لا. رصيد محفظتك لا ينتهي ولا يُخصم منه أي رسوم سكون أو رسوم شهرية.",
          "مكافآت المستويات تُضاف كرصيد عادي، وهي أيضاً لا تنتهي.",
          "إذا أغلق الصالون أو أوقف خدمته على AVO، نُبلغك قبل ٦٠ يوماً وعليه تسوية أي رصيد متبقٍ معك.",
          "بطاقة الأختام تُصفَّر بعد استلام المكافأة فقط — وهذا لا يمسّ رصيد محفظتك."
        ]
      }
    },
    {
      "id": "privacy",
      "consent": true,
      "scope": "wallet",
      "title": {
        "en": "Privacy & your data",
        "ar": "الخصوصية وبياناتك"
      },
      "body": {
        "en": [
          "We hold your name, phone number and your transaction history with this salon. Nothing more.",
          "Your number is used to send WhatsApp receipts and appointment confirmations. Turn those off under Notifications.",
          "We do not sell your data. You can request a copy, or delete your account, from this page."
        ],
        "ar": [
          "نحفظ اسمك ورقم هاتفك وسجل معاملاتك مع هذا الصالون فقط.",
          "رقمك يُستخدم لإرسال الإيصالات والتأكيدات على واتساب. يمكنك إيقافها من الإشعارات.",
          "لا نبيع بياناتك. يمكنك طلب نسخة أو حذف حسابك من هذه الصفحة."
        ]
      }
    }
  ]
};

export interface SupportSeed {
  channels: {
    whatsapp: string;
    email: string;
    hoursEn: string;
    hoursAr: string;
    replyEn: string;
    replyAr: string;
  };
  topics: Array<{ id: string; route: 'salon' | 'avo'; en: string; ar: string }>;
}

/**
 * design/avo-promotions.js § support.
 *
 * "Owned by AVO (Owner Console -> Policies -> Support) so a salon cannot point
 * customers at an unmonitored number." `route` is the field non-negotiable #11
 * is about: it decides which queue a message lands in, it is resolved on the
 * server from `topicId`, and it is never read from a request body.
 */
export const SUPPORT_CONFIG: SupportSeed = {
  "channels": {
    "whatsapp": "+965 9008 4408",
    "email": "help@avobeauty.com",
    "hoursEn": "Saturday to Thursday, 10:00 - 20:00",
    "hoursAr": "السبت إلى الخميس، ١٠:٠٠ - ٢٠:٠٠",
    "replyEn": "Most messages are answered the same working day.",
    "replyAr": "نجيب على معظم الرسائل في نفس يوم العمل."
  },
  "topics": [
    {
      "id": "wallet",
      "route": "avo",
      "en": "Wallet, top-ups or refunds",
      "ar": "المحفظة أو الشحن أو الاسترجاع"
    },
    {
      "id": "charge",
      "route": "avo",
      "en": "A charge I do not recognise",
      "ar": "خصم لا أعرفه"
    },
    {
      "id": "booking",
      "route": "salon",
      "en": "An appointment",
      "ar": "موعد"
    },
    {
      "id": "visit",
      "route": "salon",
      "en": "My visit or the service",
      "ar": "زيارتي أو الخدمة"
    },
    {
      "id": "account",
      "route": "avo",
      "en": "My account or my data",
      "ar": "حسابي أو بياناتي"
    },
    {
      "id": "other",
      "route": "avo",
      "en": "Something else",
      "ar": "شيء آخر"
    }
  ]
};
