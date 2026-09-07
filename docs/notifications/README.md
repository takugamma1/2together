# Shopify notification templates (2GETHER style)

`order-confirmation.liquid` — paste into Shopify admin → Settings → Notifications →
Customer notifications → Order confirmation → Edit code (replace everything) → Save.
Uses the cart attributes written by the drawer delivery step (Доставка, Еконт офис, Адрес, Град, Име, Телефон).

`build_email.py <out.liquid> <preview.html>` regenerates the template and a sample-data preview
from one HTML skeleton, so design tweaks go in the script, not in the two outputs.
