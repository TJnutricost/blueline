// A fake public Shopify storefront for the browser tests: answers the same three GET paths the Product Library
// uses (/search/suggest.json, /products/<handle>.js, /cart.js). Prices are integer cents, like the real endpoints.
const variant = (id, sku, price, option1, extra = {}) => ({ id, title: option1, sku, price, compare_at_price: null, available: true, option1, options: [option1], ...extra });
const product = (id, handle, title, variants) => ({ id, handle, title, featured_image: `//cdn.example.com/${handle}.jpg`, options: [{ name: 'Flavor', position: 1, values: variants.map((v) => v.option1) }], variants });

export const PRODUCTS = [
  product(1111111111, 'black-seed-oil', 'Acme Black Seed Oil', [variant(4444444441, 'ACM100101', 1997, 'Unflavored')]),
  product(1111111112, 'charcoal', 'Acme Charcoal', [variant(4444444442, 'ACM200101', 1599, 'Unflavored')]),
  product(1111111113, 'ursolic', 'Acme Ursolic Acid', [variant(4444444443, 'ACM300101', 1998, 'Unflavored', { available: false })]),
  product(1111111114, 'zma', 'Acme ZMA Capsules', [variant(4444444444, 'ACM400101', 2797, '120 ct'), variant(4444444445, 'ACM400101', 4997, '240 ct')]),
  product(1111111115, 'pre-x-workout', 'Acme Pre-X Workout Powder', [variant(4444444448, 'ACM500108', 4197, 'Blue Raz')]),
  product(1111111116, 'fish-oil', 'Acme Fish Oil Softgels', [variant(4444444449, 'ACM999001', 3097, '90 ct'), variant(4444444450, 'ACM999002', 5497, '180 ct')]),
];

export const requests = [];

// Returns { status, body } for a store path, or null when the path isn't the store's.
export function shopRoute(pathname, params) {
  if (pathname !== '/search/suggest.json' && pathname !== '/cart.js' && !/^\/products\/[^/]+\.js$/.test(pathname)) return null;
  requests.push(pathname + (params.get('q') ? `?q=${params.get('q')}` : ''));
  if (pathname === '/cart.js') return { status: 200, body: { currency: 'USD', items: [] } };
  if (pathname === '/search/suggest.json') {
    const text = (params.get('q') || '').toLowerCase();
    const skuOnly = params.get('resources[options][fields]') === 'variants.sku';
    const hits = PRODUCTS.filter((p) => (skuOnly ? p.variants.some((v) => v.sku.toLowerCase().includes(text)) : [p.title, ...p.variants.map((v) => v.sku)].join(' ').toLowerCase().includes(text) || text.split(' ').some((t) => t.length > 3 && p.title.toLowerCase().includes(t))));
    return { status: 200, body: { resources: { results: { products: hits.map((p) => ({ handle: p.handle, title: p.title })) } } } };
  }
  const p = PRODUCTS.find((x) => `/products/${x.handle}.js` === pathname);
  return p ? { status: 200, body: p } : { status: 404, body: { status: 404, description: 'Not Found' } };
}
