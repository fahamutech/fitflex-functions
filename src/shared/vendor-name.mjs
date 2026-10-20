// The name buyers see for a seller: the business (store) name from the vendor profile, else the
// account's display name; null when neither is set. One rule for product rows (vendorName on
// GET /shop/products, /discover/products, /shop/home, /shop/products/:id) and for shop home
// banners ("From {vendorName}"), so a heading read from either always matches.
const clean = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

export const storeNameOf = vendorUser => clean(vendorUser?.vendorProfile?.businessName) || clean(vendorUser?.displayName) || null;
