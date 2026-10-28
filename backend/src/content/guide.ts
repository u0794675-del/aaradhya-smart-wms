export interface GuideLink {
  label: string;
  to: string;
}

export interface GuideStep {
  title: string;
  detail: string;
}

export interface GuideSection {
  id: string;
  title: string;
  who: string;
  summary: string;
  steps: GuideStep[];
  tips: string[];
  links: GuideLink[];
}

export interface GuideContent {
  title: string;
  subtitle: string;
  version: string;
  updatedAt: string;
  intro: string;
  goldenRules: string[];
  roles: Array<{ code: string; name: string; focus: string }>;
  sections: GuideSection[];
  checklist: string[];
  glossary: Array<{ term: string; meaning: string }>;
}

export const USER_GUIDE: GuideContent = {
  title: 'Warehouse User Guide',
  subtitle: 'Naye staff ke liye simple Hinglish guide - login se report tak',
  version: '1.0',
  updatedAt: '2026-10-27',
  intro:
    'Yeh guide Aaradhya Smart WMS ko roz use karne ke liye hai. Har screen backend se validate hoti hai, isliye jo stock movement system dikhata hai wahi authoritative hai. Koi bhi quantity apne mann se adjust na karein - har entry user, time aur reference ke saath ledger me record hoti hai. Pehle is guide ko ek baar padhein, phir apne role ke section ko follow karein.',
  goldenRules: [
    'Stock sirf system ke through move karein. Register ya diary me alag se stock math na rakhein.',
    'Har movement ka proof rakhein: PO, order, transfer, return ya count reference.',
    'Galti ho jaye to record edit ya delete na karein - authorized reversal ya naya adjustment raise karein.',
    'Expired, rejected aur damaged stock ko available stock ki tarah pick na karein.',
    'Apna login kisi ke saath share na karein. Har action aapke naam par audit hota hai.',
    'Report export karte waqt OTP mandatory ho sakta hai. Code kisi ko na batayein.',
  ],
  roles: [
    { code: 'ADMIN', name: 'System Administrator', focus: 'Users, roles, settings, imports aur report branding manage karta hai.' },
    { code: 'MANAGER', name: 'Warehouse Manager', focus: 'Inbound se dispatch tak poora operation, approvals aur reports.' },
    { code: 'QC_OPERATOR', name: 'QC Operator', focus: 'Receipt inspection, acceptance/rejection aur putaway.' },
    { code: 'PICKER', name: 'Warehouse Picker', focus: 'Picking, packing aur putaway tasks.' },
    { code: 'AUDITOR', name: 'Auditor', focus: 'Read-only inventory, audit trail, genealogy aur reports.' },
    { code: 'VIEWER', name: 'Read-only Viewer', focus: 'Sirf dekh sakta hai - koi movement post nahi kar sakta.' },
  ],
  sections: [
    {
      id: 'start',
      title: '1. Shuruaat: login aur navigation',
      who: 'Sabhi users',
      summary:
        'Login ke baad aapko role ke hisaab se menu dikhta hai. Left sidebar se module kholen, upar search se koi bhi record dhoondhen.',
      steps: [
        { title: 'Sign in', detail: 'Apna work email aur password daalein. Password admin se lein aur pehli baar login par badal lein.' },
        { title: 'Menu samjhein', detail: 'Operations me daily kaam, Inventory me stock master, Control me audit/search, Administration me settings.' },
        { title: 'Global Search', detail: 'Upar search box me SKU, order number, box code ya batch number daal kar Enter dabayein.' },
        { title: 'My Inventory', detail: 'Home page par apna stock, low stock aur expiry alerts ek nazar me dikhte hain.' },
        { title: 'Notifications', detail: 'Bell icon par open alerts dikhte hain. Alert padh kar acknowledge karein, solve hone par resolve karein.' },
      ],
      tips: [
        'Har screen par refresh button hai - doosre user ka change turant dikhane ke liye refresh karein.',
        'Agar page par "service unreachable" aaye to backend band hai; admin ko batayein.',
      ],
      links: [
        { label: 'My Inventory', to: '/' },
        { label: 'Global Search', to: '/search' },
        { label: 'Notifications', to: '/notifications' },
      ],
    },
    {
      id: 'products',
      title: '2. Product Master: SKU aur barcode',
      who: 'Manager, Admin',
      summary:
        'Har product ka ek SKU, base UOM aur zarurat ho to barcode hota hai. Product galat ban gaya to stock reports galat aayengi.',
      steps: [
        { title: 'Product list kholen', detail: 'Inventory > Product Master me search karke product dhoondhen.' },
        { title: 'Naya product', detail: 'SKU, naam, category, base UOM, cost price aur low stock threshold bharein.' },
        { title: 'Barcode add karein', detail: 'Product detail me barcode add karein; duplicate barcode system reject karega.' },
        { title: 'Status check karein', detail: 'Sirf ACTIVE products naye orders aur receipts me use hote hain.' },
      ],
      tips: [
        'SKU baad me badalna avoid karein - ledger aur reports SKU se juda hota hai.',
        'Cost price sirf permission wale users ko dikhta hai.',
      ],
      links: [{ label: 'Product Master', to: '/products' }],
    },
    {
      id: 'inventory',
      title: '3. Inventory: stock kahan hai',
      who: 'Sabhi users',
      summary:
        'Inventory screen product-wise balance, location, pool, batch aur box dikhati hai. Available quantity hi naye order ke liye use hoti hai.',
      steps: [
        { title: 'Product select karein', detail: 'Search se product kholen. Har balance row location, pool, batch aur box ke saath dikhti hai.' },
        { title: 'Status samjhein', detail: 'AVAILABLE pick ho sakta hai; QUARANTINED, REJECTED, DAMAGED aur REWORK available nahi.' },
        { title: 'Ledger dekhen', detail: 'Kisi row par ledger kholen - har IN/OUT entry, user, time aur reference ke saath.' },
        { title: 'Trace kholen', detail: 'SKU ya batch par Genealogy khol kar poora safar dekhen: receipt se dispatch tak.' },
      ],
      tips: [
        'Reserved quantity doosre order ke liye hold hai; available = on hand - reserved.',
        'Expired batch pick nahi hota, chahe quantity available dikhe.',
      ],
      links: [
        { label: 'Inventory', to: '/inventory' },
        { label: 'Genealogy', to: '/trace' },
      ],
    },
    {
      id: 'inbound',
      title: '4. Inbound & QC: maal aaya',
      who: 'Receiver, QC, Manager',
      summary:
        'Vendor ka maal pehle STAGING me receive hota hai, phir QC hota hai. QC ke baad hi accepted stock putaway ke liye ready hota hai.',
      steps: [
        { title: 'Receipt banayein', detail: 'Inbound > New receipt. Vendor, PO number aur lines bharein.' },
        { title: 'Receive karein', detail: 'Physical quantity aur batch/expiry enter karein. Quantity staging location me aati hai.' },
        { title: 'QC karein', detail: 'Accepted, rejected aur damaged quantity alag-alag likhein. Rejected stock quarantine me jaata hai.' },
        { title: 'Putaway ready', detail: 'QC accepted hone par putaway task banta hai. Bina QC accepted stock rack par na bhejein.' },
      ],
      tips: [
        'Batch number aur expiry physical label se match karein.',
        'Short ya extra delivery ho to discrepancy note karein, mann se adjust na karein.',
        'QC pending stock available nahi hota.',
      ],
      links: [
        { label: 'Inbound & QC', to: '/inbound' },
        { label: 'Tasks', to: '/tasks' },
      ],
    },
    {
      id: 'putaway',
      title: '5. Putaway: rack par rakhein',
      who: 'Picker, QC, Manager',
      summary:
        'Putaway task accepted stock ko staging se rack/bin me le jaata hai. Destination scan karna zaroori ho sakta hai.',
      steps: [
        { title: 'Task kholen', detail: 'Tasks ya Inbound screen se putaway task kholen.' },
        { title: 'Location scan karein', detail: 'Rack/bin ka code scan ya type karein. Setting ke hisaab se scan mandatory hai.' },
        { title: 'Quantity confirm karein', detail: 'Task me di gayi quantity hi move karein. Box ho to box code scan karein.' },
        { title: 'Complete karein', detail: 'Confirm par stock staging se rack par chala jaata hai; ledger me PUTAWAY entry banti hai.' },
      ],
      tips: [
        'Ek task ke stock ko do jagah mat baantein - alag tasks banayein.',
        'Location capacity aur type check karein: cold/rejected stock alag zone me.',
      ],
      links: [{ label: 'Tasks', to: '/tasks' }],
    },
    {
      id: 'boxes',
      title: '6. Boxes: single aur mixed box',
      who: 'Picker, QC, Manager',
      summary:
        'Box ek physical container hai. Mixed box me ek se zyada SKU ho sakte hain. Box code scan karne se picking galti kam hoti hai.',
      steps: [
        { title: 'Box list', detail: 'Boxes screen par code, type, status aur location dekhen.' },
        { title: 'Box contents', detail: 'Box detail me SKU-wise quantity aur batch dekhen.' },
        { title: 'Box move', detail: 'Box ko move karne ke liye validated transfer ya putaway use karein.' },
        { title: 'Empty box', detail: 'Box khaali hone par status EMPTY karein, taaki galat picking na ho.' },
      ],
      tips: [
        'Box par label physical code se match karein.',
        'Mixed box se pick karte waqt SKU aur quantity dono verify karein.',
      ],
      links: [{ label: 'Boxes', to: '/boxes' }],
    },
    {
      id: 'orders',
      title: '7. Orders: B2B order aur reservation',
      who: 'Manager, Sales ops',
      summary:
        'B2B order create hone par stock reserve hota hai. Reservation ka matlab stock aapke order ke liye hold hai, move nahi hua.',
      steps: [
        { title: 'Order banayein', detail: 'Orders > New order. Customer, channel B2B, priority aur lines bharein.' },
        { title: 'Confirm karein', detail: 'Confirm par available stock reserve hota hai. Stock kam ho to line short rahegi.' },
        { title: 'Allocate karein', detail: 'Allocation specific location/batch/box chunta hai aur pick task banata hai.' },
        { title: 'Order status dekhen', detail: 'CONFIRMED, ALLOCATED, PICKING, PICKED, PACKED, DISPATCHED - har stage track hoti hai.' },
      ],
      tips: [
        'Reservation expiry setting ke hisaab se release ho sakti hai.',
        'Cancel karne par reserved stock wapas available hota hai.',
        'Order edit karne se pehle pick shuru na karein.',
      ],
      links: [
        { label: 'Orders', to: '/orders' },
        { label: 'Control Tower', to: '/control-tower' },
      ],
    },
    {
      id: 'picking',
      title: '8. Picking aur packing',
      who: 'Picker, Packer',
      summary:
        'Pick task batata hai kaunsa SKU, kitni quantity, kis location/box se lena hai. Packing me items verify karke package banaya jaata hai.',
      steps: [
        { title: 'Pick task kholen', detail: 'Tasks > PICK task. Order number aur line dikhegi.' },
        { title: 'Location/box scan', detail: 'Scan station se location aur box scan karein. Galat scan par system rok dega.' },
        { title: 'Quantity confirm', detail: 'Sirf di gayi quantity pick karein. Short ho to exception raise karein.' },
        { title: 'Pack karein', detail: 'Packing station par order lines verify karein, carton choose karein aur package seal karein.' },
      ],
      tips: [
        'Expired ya damaged stock pick mat karein.',
        'Mixed box se pick ke baad box contents system me update hote hain.',
        'Pick complete hone tak order cancel na karein.',
      ],
      links: [
        { label: 'Tasks', to: '/tasks' },
        { label: 'Scan Station', to: '/scan' },
      ],
    },
    {
      id: 'dispatch',
      title: '9. Dispatch: handover',
      who: 'Dispatch, Manager',
      summary:
        'Packed order dispatch hone par stock physically warehouse se nikalta hai. Handover ke bina order DISPATCHED na karein.',
      steps: [
        { title: 'Packed queue', detail: 'Orders me PACKED filter lagayein.' },
        { title: 'Package verify', detail: 'Package count, label aur customer details check karein.' },
        { title: 'Dispatch confirm', detail: 'Courier/vehicle detail daal kar dispatch confirm karein.' },
        { title: 'Shipment record', detail: 'Shipment number aur dispatched time automatically record hota hai.' },
      ],
      tips: [
        'Dispatch ke baad order edit nahi hota; correction return ya exception se karein.',
        'Partial dispatch ho to bachi quantity ka naya package banayein.',
      ],
      links: [{ label: 'Orders', to: '/orders' }],
    },
    {
      id: 'transfers',
      title: '10. Transfers: stock ek jagah se doosri jagah',
      who: 'Manager, Picker',
      summary:
        'Transfer se stock location, pool ya box badalta hai - total stock nahi. Approval ke baad dispatch aur receive karein.',
      steps: [
        { title: 'Transfer request', detail: 'Transfers > New transfer. From/to location, pool, product aur quantity bharein.' },
        { title: 'Approval', detail: 'Setting ke hisaab se manager approve karta hai. Apna transfer khud approve na karein.' },
        { title: 'Dispatch', detail: 'Approved transfer dispatch karein; stock IN_TRANSIT ho jaata hai.' },
        { title: 'Receive', detail: 'Destination par receive confirm karein; stock available ho jaata hai.' },
      ],
      tips: [
        'Transit me pada stock available nahi hota.',
        'Receive quantity dispatch se match karein; difference exception me daalein.',
      ],
      links: [{ label: 'Transfers', to: '/transfers' }],
    },
    {
      id: 'returns',
      title: '11. Returns: customer se maal wapas',
      who: 'Returns desk, QC, Manager',
      summary:
        'Return receive karne par stock RETURN_PENDING me aata hai. Inspection ke baad decide hota hai: restock, rework ya reject.',
      steps: [
        { title: 'Return create', detail: 'Returns > New return. Original order, customer aur reason bharein.' },
        { title: 'Inspect', detail: 'Quantity aur condition check karein. Photos/notes ho to attach karein.' },
        { title: 'Disposition', detail: 'Sellable ho to restock; damaged ho to quarantine/reject; rework ho to rework.' },
        { title: 'Close', detail: 'Disposition post hone ke baad return close karein.' },
      ],
      tips: [
        'Bina inspection stock ko available na karein.',
        'Return reason saaf likhein - audit aur reports me kaam aata hai.',
      ],
      links: [{ label: 'Returns', to: '/returns' }],
    },
    {
      id: 'counts',
      title: '12. Cycle Counts: physical count',
      who: 'Manager, Auditor',
      summary:
        'Cycle count physical stock ko system se match karta hai. Difference approve hone ke baad hi adjustment post hota hai.',
      steps: [
        { title: 'Count session', detail: 'Cycle Counts > New session. Location ya SKU range chunein.' },
        { title: 'Count enter', detail: 'Physical quantity darj karein. Blind count me system quantity pehle na dekhen.' },
        { title: 'Review difference', detail: 'System vs physical difference dikhega. Reason likhein.' },
        { title: 'Approve', detail: 'Doosra authorized user approve kare; tab adjustment ledger me post hota hai.' },
      ],
      tips: [
        'Count ke waqt stock movement rok dein.',
        'Difference ka reason bina likhe approve na karein.',
      ],
      links: [{ label: 'Cycle Counts', to: '/counts' }],
    },
    {
      id: 'adjustments',
      title: '13. Adjustments: authorized correction',
      who: 'Manager, Admin',
      summary:
        'Damage, theft, expiry ya data correction ke liye adjustment use karein. Bada adjustment approval ke baad post hota hai.',
      steps: [
        { title: 'Adjustment request', detail: 'Adjustments > New. Product, location, direction IN/OUT, quantity aur reason bharein.' },
        { title: 'Threshold', detail: 'Setting se zyada quantity ho to status PENDING_APPROVAL aata hai.' },
        { title: 'Second approver', detail: 'Requester apna adjustment approve nahi kar sakta. Doosra authorized user approve kare.' },
        { title: 'Post', detail: 'Approve hone par stock movement ledger me post hota hai.' },
      ],
      tips: [
        'Reason clear likhein: damage, expiry, count difference, data correction.',
        'Correction ke liye purani entry edit na karein; reversal ya adjustment hi sahi tarika hai.',
      ],
      links: [{ label: 'Adjustments', to: '/adjustments' }],
    },
    {
      id: 'reports',
      title: '14. Reports: PDF, Excel aur CSV',
      who: 'Manager, Auditor, Admin',
      summary:
        'Reports backend ke ledger aur balances se banti hain. Stock summary, movement aur expiry report ko PDF, Excel ya CSV me export karein.',
      steps: [
        { title: 'Report kholen', detail: 'Reports me tab chunein: Stock summary, Movements ya Expiry.' },
        { title: 'Filter lagayein', detail: 'Search/category ya date range chunein. Screen par result check karein.' },
        { title: 'Export dabayein', detail: 'Export report par click karein. Format PDF, Excel ya CSV chunein.' },
        { title: 'Template chunein', detail: 'PDF/Excel ke liye Executive, Classic ya Minimal template chunein.' },
        { title: 'OTP verify karein', detail: 'Agar OTP mandatory hai to authenticator ka 6-digit code ya email code daalein.' },
        { title: 'Download', detail: 'File download hogi. PDF par company name, logo aur watermark lagta hai.' },
      ],
      tips: [
        'Cost column sirf cost permission wale users ko dikhta hai.',
        'Report generate hone ka audit record banta hai - kis user ne kaunsa format export kiya.',
        'Email OTP ke liye SMTP configured hona chahiye; warna authenticator app use karein.',
        'CSV me sirf pehli table aati hai; poori detail ke liye PDF ya Excel chunein.',
      ],
      links: [{ label: 'Reports', to: '/reports' }],
    },
    {
      id: 'security',
      title: '15. Security: OTP aur my security',
      who: 'Sabhi users',
      summary:
        'Report export ko OTP se protect kiya ja sakta hai. Har user apna authenticator app khud enroll karta hai.',
      steps: [
        { title: 'My Security kholen', detail: 'Sidebar > My Security. TOTP status aur email delivery status dikhega.' },
        { title: 'Authenticator enroll', detail: 'Set up authenticator dabayein, QR scan karein ya secret key manually daalein.' },
        { title: 'Confirm', detail: 'App me dikh raha 6-digit code daal kar confirm karein.' },
        { title: 'Disable', detail: 'Disable ke liye password chahiye. OTP mandatory hone par disable block ho sakta hai.' },
      ],
      tips: [
        'Code har 30 second me badalta hai; purana code dobara use nahi hota.',
        'QR kisi ke saath share na karein; secret key screen capture na karein.',
        'Email code 5 minute me expire hota hai aur limited attempts hote hain.',
      ],
      links: [{ label: 'My Security', to: '/security' }],
    },
    {
      id: 'control',
      title: '16. Audit, exceptions aur notifications',
      who: 'Manager, Auditor',
      summary:
        'Audit trail immutable hai. Har stock movement, setting change, permission denial aur report export record hota hai.',
      steps: [
        { title: 'Audit Trail', detail: 'Event type, user, date, entity aur outcome se filter karein.' },
        { title: 'Genealogy', detail: 'Product, batch, box, order ya transfer ka poora safar ek timeline me dekhen.' },
        { title: 'Exceptions', detail: 'Short pick, damage, mismatch ya system issue raise karein aur investigate karein.' },
        { title: 'Notifications', detail: 'Low stock, expiry aur approval alerts acknowledge/resolve karein.' },
      ],
      tips: [
        'Audit entry edit ya delete nahi hoti - isliye action se pehle soch lein.',
        'Exception detail me reference number zaroor likhein.',
      ],
      links: [
        { label: 'Audit Trail', to: '/audit' },
        { label: 'Exceptions', to: '/exceptions' },
      ],
    },
    {
      id: 'settings',
      title: '17. Settings aur report branding',
      who: 'Admin',
      summary:
        'Settings me operational rules, report OTP policy aur report branding manage hoti hai. Har change audit hota hai.',
      steps: [
        { title: 'Rules', detail: 'Expiry warning days, approval threshold, low stock default aur scan rules set karein.' },
        { title: 'Report Studio', detail: 'Company name, tagline, address, logo, watermark, colours aur template set karein.' },
        { title: 'Report OTP', detail: 'OTP mandatory on/off karein. On karne se pehle authenticator enroll ya SMTP configure karein.' },
        { title: 'Email test', detail: 'SMTP configured hone par apne aap ko test email bhejein.' },
      ],
      tips: [
        'Logo PNG ya JPEG, 2 MB se chhota rakhein.',
        'Watermark opacity 0.02 se 0.5 ke beech rakhein.',
        'OTP mandatory karte hi purane CSV links block ho jaate hain; Export dialog use karein.',
      ],
      links: [{ label: 'Settings', to: '/settings' }],
    },
    {
      id: 'daily',
      title: '18. Daily checklist aur troubleshooting',
      who: 'Sabhi users',
      summary:
        'Shift start aur end par yeh checklist follow karein. Problem aaye to pehle yeh common checks karein.',
      steps: [
        { title: 'Shift start', detail: 'My Inventory kholen, notifications dekhen, pending tasks aur approvals check karein.' },
        { title: 'Shift end', detail: 'Open pick/putaway tasks complete karein, damaged stock quarantine karein, exceptions note karein.' },
        { title: 'Scan fail', detail: 'Barcode/label saaf karein, manual code type karein, phir bhi fail ho to exception raise karein.' },
        { title: 'Stock mismatch', detail: 'Mann se adjust na karein; cycle count ya authorized adjustment raise karein.' },
        { title: 'Login issue', detail: 'Caps Lock aur email check karein. Account locked ho to admin se reset karayein.' },
      ],
      tips: [
        'Backend unreachable ho to internet/local server check karein aur admin ko batayein.',
        'Report OTP na aaye to spam folder dekhen, phir naya code request karein.',
      ],
      links: [{ label: 'My Inventory', to: '/' }],
    },
  ],
  checklist: [
    'Pending approvals check karein (transfers, adjustments, cycle counts).',
    'Low stock aur expiry alerts review karein.',
    'Open pick aur putaway tasks complete ya reassign karein.',
    'Damaged/rejected stock quarantine me hai confirm karein.',
    'Exceptions aur notifications acknowledge karein.',
    'Shift end par apna kaam aur handover note likhein.',
  ],
  glossary: [
    { term: 'SKU', meaning: 'Product ka unique code.' },
    { term: 'UOM', meaning: 'Unit of measure - PIECE, BOX, KG etc.' },
    { term: 'Pool', meaning: 'Stock ka ownership group. Yeh system B2B aur SHARED pool use karta hai.' },
    { term: 'Reservation', meaning: 'Order ke liye hold ki gayi quantity; stock move nahi hua.' },
    { term: 'Available', meaning: 'On hand minus reserved; naye order ke liye usable.' },
    { term: 'Putaway', meaning: 'Staging se rack/bin me stock rakhna.' },
    { term: 'Reversal', meaning: 'Galat movement ko ulta movement se correct karna.' },
    { term: 'TOTP', meaning: 'Authenticator app ka 30-second wala 6-digit code.' },
    { term: 'Audit trail', meaning: 'Har action ka immutable record.' },
    { term: 'Watermark', meaning: 'Report par halka printed company text.' },
  ],
};
