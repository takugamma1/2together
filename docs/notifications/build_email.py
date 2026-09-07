# Generates the Shopify "Order confirmation" notification template in the 2GETHER style
# and a static preview with sample data (same skeleton, so they can't drift apart).
import sys, pathlib

INK, SURF, RAISED, FLAME, TEXT, MUTED, DIV = '#0B1220', '#0D1526', '#121E34', '#E8601C', '#E8ECF2', '#8A9BB5', '#22304A'
FONT = "'General Sans', 'Inter', Arial, Helvetica, sans-serif"
DISPLAY = "'Technor', 'Unbounded', Arial Black, Arial, Helvetica, sans-serif"

def label(text):
    return (f'<p style="margin:0 0 10px;font-family:{FONT};font-size:11px;font-weight:700;letter-spacing:0.16em;'
            f'text-transform:uppercase;color:{FLAME};">// {text}</p>')

def section(inner):
    return (f'<tr><td style="padding:0 32px 28px;">{inner}</td></tr>')

def skeleton(s):
    """s: dict of slots (liquid or sample strings)."""
    return f'''<!DOCTYPE html>
<html lang="bg">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>{s['title']}</title>
<style>
  body {{ margin:0; padding:0; background:{INK}; -webkit-text-size-adjust:100%; }}
  table {{ border-collapse:collapse; }}
  img {{ border:0; display:block; }}
  a {{ color:{FLAME}; }}
  @media (max-width: 620px) {{
    .wrap {{ width:100% !important; }}
    .pad {{ padding-left:20px !important; padding-right:20px !important; }}
    .title {{ font-size:30px !important; line-height:1.05 !important; }}
    .stack {{ display:block !important; width:100% !important; }}
    .stack-gap {{ padding-top:14px !important; }}
  }}
</style>
</head>
<body style="margin:0;padding:0;background:{INK};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">{s['preheader']}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{INK};">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:{SURF};border:1px solid {DIV};">

  <!-- top flame bar (brand slash) -->
  <tr><td style="height:4px;background:{FLAME};font-size:0;line-height:0;">&nbsp;</td></tr>

  <!-- header -->
  <tr><td class="pad" style="padding:28px 32px 8px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle;">{s['logo']}</td>
      <td align="right" style="vertical-align:middle;font-family:{FONT};font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:{MUTED};">
        Поръчка <span style="color:{TEXT};">{s['order_name']}</span><br>
        <span style="font-weight:500;letter-spacing:0.08em;">{s['order_date']}</span>
      </td>
    </tr></table>
  </td></tr>

  <!-- hero -->
  <tr><td class="pad" style="padding:24px 32px 8px;">
    {label('Потвърдена поръчка')}
    <h1 class="title" style="margin:0 0 14px;font-family:{DISPLAY};font-size:38px;line-height:1;font-weight:800;letter-spacing:-0.02em;text-transform:uppercase;color:{TEXT};">{s['headline']}</h1>
    <p style="margin:0 0 22px;font-family:{FONT};font-size:15px;line-height:1.6;color:{MUTED};">{s['intro']}</p>
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="background:{FLAME};border-right:8px solid {INK};">
        <a href="{s['status_url']}" style="display:inline-block;padding:15px 26px;font-family:{FONT};font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:{INK};text-decoration:none;">Виж поръчката &nbsp;&rarr;</a>
      </td>
    </tr></table>
  </td></tr>

  <tr><td class="pad" style="padding:24px 32px 0;"><div style="height:1px;background:{DIV};font-size:0;line-height:0;">&nbsp;</div></td></tr>

  <!-- items -->
  <tr><td class="pad" style="padding:24px 32px 6px;">
    {label('Артикули')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      {s['items']}
    </table>
  </td></tr>

  <!-- totals -->
  <tr><td class="pad" style="padding:8px 32px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid {DIV};">
      {s['totals']}
    </table>
  </td></tr>

  <!-- delivery + payment -->
  <tr><td class="pad" style="padding:0 32px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td class="stack" width="50%" style="vertical-align:top;padding-right:10px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{RAISED};border-left:3px solid {FLAME};"><tr><td style="padding:16px 18px;">
          {label('Доставка')}
          <p style="margin:0;font-family:{FONT};font-size:14px;line-height:1.6;color:{TEXT};">{s['delivery']}</p>
        </td></tr></table>
      </td>
      <td class="stack stack-gap" width="50%" style="vertical-align:top;padding-left:10px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{RAISED};border-left:3px solid {FLAME};"><tr><td style="padding:16px 18px;">
          {label('Плащане')}
          <p style="margin:0;font-family:{FONT};font-size:14px;line-height:1.6;color:{TEXT};">{s['payment']}</p>
        </td></tr></table>
      </td>
    </tr></table>
  </td></tr>

  {s['note']}

  <!-- help -->
  <tr><td class="pad" style="padding:0 32px 30px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid {DIV};"><tr><td style="padding:18px 20px;font-family:{FONT};font-size:13px;line-height:1.6;color:{MUTED};">
      <span style="color:{TEXT};font-weight:600;">Въпрос за поръчката?</span> Отговори на този имейл или ни се обади на <a href="tel:+359888310500" style="color:{FLAME};text-decoration:none;font-weight:600;">+359 888 310 500</a>. Работим понеделник–събота.
    </td></tr></table>
  </td></tr>

  <!-- footer -->
  <tr><td style="background:{INK};padding:24px 32px;border-top:1px solid {DIV};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:{DISPLAY};font-size:14px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;color:{TEXT};">2GETHER<span style="color:{FLAME};">/</span>BIKES</td>
      <td align="right" style="font-family:{FONT};font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">
        <a href="{s['shop_url']}" style="color:{MUTED};text-decoration:none;">Магазин</a>&nbsp;&nbsp;·&nbsp;&nbsp;
        <a href="{s['shop_url']}/blogs/club-2together" style="color:{MUTED};text-decoration:none;">Клуб</a>&nbsp;&nbsp;·&nbsp;&nbsp;
        <a href="{s['shop_url']}/pages/bike-service" style="color:{MUTED};text-decoration:none;">Сервиз</a>
      </td>
    </tr>
    <tr><td colspan="2" style="padding-top:12px;font-family:{FONT};font-size:11px;line-height:1.7;color:{MUTED};">
      Варна · <a href="mailto:sales@2getherbikes.bg" style="color:{MUTED};text-decoration:none;">sales@2getherbikes.bg</a> · Този имейл е изпратен, защото направи поръчка в 2getherbikes.bg.
    </td></tr></table>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>
'''

def item_row(img, title, variant, qty_price, line_total):
    return f'''<tr>
        <td width="64" style="padding:12px 0;border-bottom:1px solid {DIV};vertical-align:top;">{img}</td>
        <td style="padding:12px 14px;border-bottom:1px solid {DIV};vertical-align:top;font-family:{FONT};">
          <p style="margin:0;font-size:14px;font-weight:600;line-height:1.4;color:{TEXT};">{title}</p>
          {variant}
          <p style="margin:4px 0 0;font-size:12px;color:{MUTED};">{qty_price}</p>
        </td>
        <td align="right" style="padding:12px 0;border-bottom:1px solid {DIV};vertical-align:top;white-space:nowrap;font-family:{DISPLAY};font-size:15px;font-weight:700;color:{TEXT};">{line_total}</td>
      </tr>'''

def total_row(name, value, strong=False):
    if strong:
        return (f'<tr><td style="padding:14px 0 0;font-family:{FONT};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:{TEXT};">{name}</td>'
                f'<td align="right" style="padding:14px 0 0;font-family:{DISPLAY};font-size:24px;font-weight:800;letter-spacing:-0.01em;color:{FLAME};">{value}</td></tr>')
    return (f'<tr><td style="padding:10px 0 0;font-family:{FONT};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:{MUTED};">{name}</td>'
            f'<td align="right" style="padding:10px 0 0;font-family:{FONT};font-size:14px;font-weight:600;color:{TEXT};">{value}</td></tr>')

def note_block(text):
    return (f'<tr><td class="pad" style="padding:0 32px 28px;">{label("Бележка към поръчката")}'
            f'<p style="margin:0;font-family:{FONT};font-size:14px;line-height:1.6;color:{TEXT};">{text}</p></td></tr>')

# ------------------------------------------------------------------ Liquid version
img_liquid = ('{% if line.image %}<img src="{{ line | img_url: \'compact_cropped\' }}" width="64" height="64" alt="" '
              f'style="width:64px;height:64px;background:{RAISED};">{{% else %}}<div style="width:64px;height:64px;background:{RAISED};"></div>{{% endif %}}')
variant_liquid = ('{% if line.variant.title != blank and line.variant.title != \'Default Title\' %}'
                  f'<p style="margin:2px 0 0;font-size:12px;color:{MUTED};">{{{{ line.variant.title }}}}</p>{{% endif %}}')
items_liquid = ('{% for line in subtotal_line_items %}' +
                item_row(img_liquid, '{{ line.title }}', variant_liquid,
                         '{{ line.quantity }} × {{ line.original_price | money }}'
                         '{% if line.original_price != line.final_price %} &nbsp;<span style="color:' + FLAME + ';">отстъпка</span>{% endif %}',
                         '{{ line.final_line_price | money }}') +
                '{% endfor %}')

totals_liquid = (
    total_row('Междинна сума', '{{ subtotal_price | money }}') +
    '{% for discount_application in discount_applications %}' +
    total_row('Отстъпка{% if discount_application.title != blank %} · {{ discount_application.title }}{% endif %}',
              '−{{ discount_application.total_allocated_amount | money }}') +
    '{% endfor %}' +
    total_row('Доставка{% if shipping_method %} · {{ shipping_method.title }}{% endif %}',
              '{% if shipping_price == 0 %}Безплатна{% else %}{{ shipping_price | money }}{% endif %}') +
    '{% for tax_line in tax_lines %}' +
    total_row('{{ tax_line.title }} {{ tax_line.rate | times: 100 | round }}%', '{{ tax_line.price | money }}') +
    '{% endfor %}' +
    total_row('Общо', '{{ total_price | money }}', strong=True)
)

delivery_liquid = '''{%- assign d_mode = attributes['Доставка'] -%}
          {%- if d_mode != blank -%}<span style="color:''' + FLAME + ''';font-weight:700;">{{ d_mode }}</span><br>{%- endif -%}
          {%- if attributes['Еконт офис'] != blank -%}{{ attributes['Еконт офис'] }}<br>{%- endif -%}
          {%- if attributes['Адрес'] != blank -%}{{ attributes['Адрес'] }}<br>{%- endif -%}
          {%- if attributes['Град'] != blank -%}{{ attributes['Град'] }}<br>{%- endif -%}
          {%- if attributes['Еконт офис'] == blank and attributes['Адрес'] == blank and shipping_address -%}
            {{ shipping_address.address1 }}{% if shipping_address.address2 != blank %}, {{ shipping_address.address2 }}{% endif %}<br>{{ shipping_address.zip }} {{ shipping_address.city }}<br>
          {%- endif -%}
          <span style="color:''' + MUTED + ''';">{% if attributes['Име'] != blank %}{{ attributes['Име'] }}{% elsif shipping_address %}{{ shipping_address.name }}{% else %}{{ customer.name }}{% endif %}{% if attributes['Телефон'] != blank %} · {{ attributes['Телефон'] }}{% elsif shipping_address.phone != blank %} · {{ shipping_address.phone }}{% endif %}</span>'''

payment_liquid = '''{%- for transaction in transactions -%}{%- if forloop.first -%}<span style="font-weight:700;">{{ transaction.gateway_display_name }}</span>{%- endif -%}{%- endfor -%}
          {%- if payment_terms and payment_terms.type != 'receipt' -%}<br><span style="color:''' + MUTED + ''';">Дължимо: {{ total_outstanding | money }}</span>{%- endif -%}
          {%- assign gw = '' -%}{%- for transaction in transactions -%}{%- if forloop.first -%}{%- assign gw = transaction.gateway_display_name | downcase -%}{%- endif -%}{%- endfor -%}
          {%- if gw contains 'налож' or gw contains 'cash on delivery' or gw contains 'cod' -%}<br><span style="color:''' + MUTED + ''';">Плащаш на куриера при получаване.</span>{%- endif -%}'''

liquid = skeleton({
    'title': 'Поръчка {{ order_name }} — {{ shop.name }}',
    'preheader': 'Получихме поръчка {{ order_name }} и вече я подготвяме.',
    'logo': ('{% if shop.email_logo_url %}<img src="{{ shop.email_logo_url }}" width="{{ shop.email_logo_width | default: 140 }}" alt="{{ shop.name }}" '
             'style="max-width:160px;height:auto;">{% else %}<span style="font-family:' + DISPLAY + ';font-size:20px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;color:' + TEXT + ';">2GETHER<span style="color:' + FLAME + ';">/</span>BIKES</span>{% endif %}'),
    'order_name': '{{ order_name }}',
    'order_date': '{{ order.created_at | date: "%d.%m.%Y" }}',
    'headline': '{% if customer.first_name != blank %}Благодарим, {{ customer.first_name }}!{% else %}Благодарим!{% endif %}',
    'intro': 'Получихме поръчката ти и вече я подготвяме. Ще ти пишем отново, когато я предадем на Еконт.',
    'status_url': '{{ order_status_url }}',
    'items': items_liquid,
    'totals': totals_liquid,
    'delivery': delivery_liquid,
    'payment': payment_liquid,
    'note': '{% if order.note != blank %}' + note_block('{{ order.note }}') + '{% endif %}',
    'shop_url': '{{ shop.url }}',
})

# ------------------------------------------------------------------ Preview with sample data
def ph(): return f'<div style="width:64px;height:64px;background:{RAISED};"></div>'
items_preview = (
    item_row(ph(), 'Santa Cruz Hightower C R', f'<p style="margin:2px 0 0;font-size:12px;color:{MUTED};">Размер L · Gloss Black</p>', '1 × 4 899,00 €', '4 899,00 €') +
    item_row(ph(), 'Galfer Disc Shark Center-Lock Ø203', '', '2 × 90,00 €', '180,00 €') +
    item_row(ph(), 'ODI Troy Lee Designs Lock-On Grips', f'<p style="margin:2px 0 0;font-size:12px;color:{MUTED};">Orange</p>', f'1 × 34,90 € &nbsp;<span style="color:{FLAME};">отстъпка</span>', '29,90 €')
)
totals_preview = (total_row('Междинна сума', '5 108,90 €') + total_row('Отстъпка · КЛУБ10', '−5,00 €') +
                  total_row('Доставка · Еконт до офис', '7,41 €') + total_row('Общо', '5 111,31 €', strong=True))
preview = skeleton({
    'title': 'Поръчка #1042 — 2getherbikes',
    'preheader': 'Получихме поръчка #1042 и вече я подготвяме.',
    'logo': f'<span style="font-family:{DISPLAY};font-size:20px;font-weight:800;letter-spacing:0.04em;text-transform:uppercase;color:{TEXT};">2GETHER<span style="color:{FLAME};">/</span>BIKES</span>',
    'order_name': '#1042', 'order_date': '07.09.2026',
    'headline': 'Благодарим, Иван!',
    'intro': 'Получихме поръчката ти и вече я подготвяме. Ще ти пишем отново, когато я предадем на Еконт.',
    'status_url': '#', 'items': items_preview, 'totals': totals_preview,
    'delivery': f'<span style="color:{FLAME};font-weight:700;">Еконт — до офис</span><br>Варна [код 9035] — Варна бул. Република №59<br>Варна 9000<br><span style="color:{MUTED};">Иван Тестов · +359888123456</span>',
    'payment': f'<span style="font-weight:700;">Наложен платеж (COD)</span><br><span style="color:{MUTED};">Плащаш на куриера при получаване.</span>',
    'note': note_block('Моля, обадете се преди доставка.'),
    'shop_url': 'https://2getherbikes.bg',
})

out_liquid, out_preview = sys.argv[1], sys.argv[2]
pathlib.Path(out_liquid).write_text(liquid, encoding='utf-8')
pathlib.Path(out_preview).write_text(preview, encoding='utf-8')
print('liquid', len(liquid), 'preview', len(preview))
