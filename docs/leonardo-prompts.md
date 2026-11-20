# أوامر Leonardo لصور اللعبة

الفكرة: كل الصور بنفس الستايل عشان اللعبة تطلع متناسقة. انسخ **الستايل الثابت** في كل مرة وحط جنبه وصف الأصل.

## الإعدادات المقترحة

- المقاس: 1024×1024 (مربع). بعد التوليد صغّرها لـ 256×256.
- الصيغة المطلوبة للعبة: `webp` (أو غيّر الامتداد في `app.js` لو ملفاتك png).
- ثبّت نفس الموديل ونفس الـ Seed أو الـ Style Reference بين الصور عشان الستايل ما يتغيرش.
- استخدم Negative prompt: `text, letters, logo, watermark, photo, realistic, blurry, extra objects`.

## الستايل الثابت (انسخه مع كل أمر)

```
flat vector game icon, bold clean shapes, thick soft outlines, warm saturated colors with gold highlights, subtle Egyptian street-culture charm, centered single object, plain deep teal background (#0F2A2B), no text, no letters, no watermark, square composition, mobile game asset
```

## تسمية الملفات والرفع

1. سمّي كل صورة باسم الـ `key` الموجود جنب الأصل (مثال: `tuktuk.webp`).
2. ارفعها على GitHub داخل المجلد `public/img/assets/` (Add file ← Upload files).
3. افتح `public/app.js` وغيّر السطر `const ASSET_IMAGES = false;` إلى `true`.
4. اللعبة هتستخدم الصورة لو موجودة، ولو صورة ناقصة هتفضل الأيقونة البسيطة.

## الشخصية والأيقونة

| الاسم | الوصف |
|---|---|
| `mayor` (زرار الضغط) | an Egyptian village mayor (omda) wearing a red tarboosh fez, mustache, holding a stack of cash, friendly confident smile, bust portrait |
| `app_icon` (صورة البوت) | a red tarboosh fez on a gold circle, bold simple emblem |

## أوامر الأصول الـ 40

| # | الملف | الاسم | الوصف (English subject) |
|---|---|---|---|
| 1 | `tuktuk.webp` | توك توك | a three-wheeled Egyptian tuk tuk rickshaw, slightly dented, colorful stickers |
| 2 | `fool_cart.webp` | عربية فول | a street food cart selling fava beans (ful medames), with bread stack and metal pots |
| 3 | `furnished_flat.webp` | شقة مفروشة | a small apartment building balcony with a neon "furnished" sign and clothes line |
| 4 | `microbus.webp` | ميكروباص | a white Egyptian minibus microbus packed with passengers, side door open |
| 5 | `koshary_cart.webp` | عربية كشري | a koshary street cart with steaming pot, fried onions, tomato sauce bowls |
| 6 | `shop_corner.webp` | محل على الناصية | a tiny corner grocery shop with striped awning, crates of fruit outside |
| 7 | `taxi_white.webp` | تاكسي أبيض | a classic white Cairo taxi with a roof sign |
| 8 | `shawarma_shop.webp` | محل شاورما | a shawarma shop with a rotating meat spit and wrap sandwiches |
| 9 | `old_rent_building.webp` | عمارة إيجار قديم | an old five-story Cairo apartment building with balconies and satellite dishes |
| 10 | `taxi_app.webp` | تاكسي تطبيق | a modern compact car with a glowing phone-app pin icon above it |
| 11 | `grill_restaurant.webp` | مطعم مشويات | a grill restaurant with skewers of kebab over charcoal flames |
| 12 | `villa_coast.webp` | فيلا على الساحل | a seaside villa with palm trees and turquoise sea on the Egyptian north coast |
| 13 | `tourist_bus.webp` | أتوبيس سياحي | a big tourist coach bus with pyramids painted on the side |
| 14 | `restaurant_chain.webp` | سلسلة مطاعم | a restaurant storefront with a big sign and three small branch signs |
| 15 | `shopping_mall.webp` | مول تجاري | a multi-level shopping mall with glass front and a sale banner |
| 16 | `truck_fleet.webp` | أسطول نقل ثقيل | three heavy cargo trucks in a row on the road |
| 17 | `cafe_chain.webp` | سلسلة كافيهات | a coffee shop with a steaming cup and a shisha-free cozy terrace |
| 18 | `compound.webp` | كمبوند | a gated residential compound with identical villas and a green gate |
| 19 | `forge_workshop.webp` | ورشة حدادة | a blacksmith workshop with an anvil, sparks and a hammer |
| 20 | `nile_ferry.webp` | معدية النيل | a small ferry boat crossing the Nile at sunset with a felucca sail |
| 21 | `food_factory.webp` | مصنع أغذية | a food packaging factory with a conveyor belt of canned goods |
| 22 | `capital_towers.webp` | أبراج العاصمة | a cluster of tall glass skyscrapers of a new capital |
| 23 | `brick_factory.webp` | مصنع طوب | a red brick factory with a tall smokestack and stacked bricks |
| 24 | `cargo_ship.webp` | سفينة شحن | a container cargo ship loaded with colorful containers |
| 25 | `sweets_empire.webp` | إمبراطورية الحلويات | a grand sweets shop with towering trays of basbousa and baklava |
| 26 | `new_city.webp` | مدينة جديدة | a modern new city skyline with towers, roads and a mosque dome |
| 27 | `clothing_factory.webp` | مصنع ملابس | a clothing factory with rolls of fabric and sewing machines |
| 28 | `furniture_factory.webp` | مصنع أثاث | a furniture workshop with a wooden armchair and carpentry tools |
| 29 | `golden_car.webp` | عربية مطلية دهب | a luxury sedan completely plated in gold, shiny and exaggerated |
| 30 | `free_zone.webp` | منطقة حرة | an industrial free zone gate with cranes and shipping containers |
| 31 | `yacht.webp` | يخت فاخر | a luxury white yacht on blue water |
| 32 | `steel_mill.webp` | مصنع حديد وصلب | a steel mill with glowing molten metal and chimneys |
| 33 | `helicopter.webp` | هليكوبتر | a sleek private helicopter on a helipad |
| 34 | `cement_plant.webp` | مصنع أسمنت | a cement plant with silos and a mixer truck |
| 35 | `private_jet.webp` | طيارة خاصة | a private jet plane with a red carpet stairway |
| 36 | `car_plant.webp` | مصنع سيارات | a car assembly plant with a robot arm and a half-built car |
| 37 | `private_airport.webp` | مطار خاص | a small private airport with a tower, a runway and a jet |
| 38 | `private_island.webp` | جزيرة خاصة | a tropical private island with a villa, a palm tree and a dock |
| 39 | `satellite.webp` | قمر صناعي | a communications satellite with solar panels orbiting above the Earth |
| 40 | `palace.webp` | القصر الجمهوري | a grand presidential palace with a domed center, columns and a flag, golden hour |

**الأمر الكامل لكل أصل:** `<الوصف>, flat vector game icon, bold clean shapes, thick soft outlines, warm saturated colors with gold highlights, subtle Egyptian street-culture charm, centered single object, plain deep teal background (#0F2A2B), no text, no letters, no watermark, square composition, mobile game asset`

