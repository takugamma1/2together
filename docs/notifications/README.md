# Shopify notification templates (2GETHER style)

`order-confirmation.liquid` — paste into Shopify admin → Settings → Notifications →
Customer notifications → Order confirmation → Edit code (replace everything) → Save.
Uses the cart attributes written by the drawer delivery step (Доставка, Еконт офис, Адрес, Град, Име, Телефон).

`shipping-confirmation.liquid` — same place → Shipping confirmation. Tracking button links to Econt's tracker when Shopify has no tracking URL.

`build_email.py <order.liquid> <order-preview.html> <shipping.liquid> <shipping-preview.html>` regenerates the templates and a sample-data preview
from one HTML skeleton, so design tweaks go in the script, not in the two outputs.
