// The categories a vendor chooses from (product owner, 11 Oct 2026). A vendor
// picks one or more for their business; each product picks one. "events" is
// for ticket sales (marathons, fitness events and the like).
export const PRODUCT_CATEGORIES = Object.freeze([
  { key: 'supplements_nutrition', en: 'Supplements & nutrition', sw: 'Virutubisho na lishe' },
  { key: 'sportswear_footwear', en: 'Sportswear & footwear', sw: 'Mavazi na viatu vya michezo' },
  { key: 'equipment', en: 'Gym & fitness equipment', sw: 'Vifaa vya gym na mazoezi' },
  { key: 'accessories_gear', en: 'Accessories & gear', sw: 'Vifaa vidogo na zana' },
  { key: 'food_drinks', en: 'Food & drinks', sw: 'Chakula na vinywaji' },
  { key: 'health_recovery', en: 'Health & recovery', sw: 'Afya na kupona' },
  { key: 'events', en: 'Events & tickets', sw: 'Matukio na tiketi' },
  { key: 'other', en: 'Other', sw: 'Nyingine' },
]);
export const PRODUCT_CATEGORY_KEYS = new Set(PRODUCT_CATEGORIES.map(c => c.key));

/** Who a vendor's person on the KYC case is (replaces the "authorised representative"). */
export const VENDOR_POSITIONS = Object.freeze(['owner', 'co_owner', 'employee']);
