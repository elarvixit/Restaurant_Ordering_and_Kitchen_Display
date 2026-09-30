'use strict';
// Every table (and index) name the app uses, in one place. All of them start with PREFIX so the app
// can share a Supabase project with other apps. The names are double-quoted in SQL so Postgres keeps
// the capital letters exactly as written (unquoted names would be folded to lower case).
// supabase/schema.sql creates the same tables: keep the two in step.

const PREFIX = 'babji_RestaurantKitchen_';
const BASE = ['menu_categories', 'menu_items', 'tables', 'bills', 'orders', 'order_items', 'app_state', 'login_failures'];

// NAMES.orders -> babji_RestaurantKitchen_orders      (plain, for catalog lookups)
// T.orders     -> "babji_RestaurantKitchen_orders"    (quoted, for use inside SQL)
const NAMES = Object.fromEntries(BASE.map((b) => [b, PREFIX + b]));
const T = Object.fromEntries(BASE.map((b) => [b, `"${PREFIX}${b}"`]));
const index = (name) => `"${PREFIX}${name}"`;

module.exports = { PREFIX, BASE, NAMES, T, index };
