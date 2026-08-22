#!/usr/bin/env python3
"""Derive storefront facet tags ("Family: value") from product titles/types/options.
Re-runnable: tags of the managed families are recomputed; everything else is kept.
Usage: python3 migration/auto_tags.py [--apply]   (reads .env in repo root)"""
import os, re, sys, json, time, urllib.request, collections
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = dict(l.strip().split('=', 1) for l in open(os.path.join(ROOT, '.env')) if '=' in l and not l.startswith('#'))
API = f"https://{env['SHOPIFY_STORE']}/admin/api/2025-07/graphql.json"

def gql(q, v=None):
    for _ in range(6):
        rq = urllib.request.Request(API, data=json.dumps({'query': q, 'variables': v or {}}).encode(),
                                    headers={'Content-Type': 'application/json', 'X-Shopify-Access-Token': env['SHOPIFY_ADMIN_TOKEN']})
        r = json.load(urllib.request.urlopen(rq))
        if r.get('errors') and 'Throttled' in str(r['errors']): time.sleep(2); continue
        if r.get('errors'): raise SystemExit(r['errors'])
        return r['data']

MANAGED = {'Clothes Size','Helmet Size','Shoe Size','Gender','Diameter','Width','Length','Clamp','Travel','Mount','Compatibility',
           'Compound','Standard','Spacing','Holes','Position','Type','Lumens','Volume','Deck Width','Shape','Offset','Number Of Teeth',
           'Frame Size','Wheel Size','Bearing Size','Spoke Type','Rise','Lens','Crank Length'}

CLOTHING = {'Jerseys','T-shirts','Shorts','Pants','Hoodies','Jackets','Gloves','Socks','Vests','Bibs','Base Layer','Sweatshirts','Snow Gloves',
            'Snow Jackets','Snow Pants','Snow Hoodies','Winter Headwear','Riding Hoodie','Other Ride Wear','Casual Wear','Winter Casual','Ride Kit','Hats'}
PROTECTION = {'Kneeguard','Elbowguard','Protectors','Body Protector','Chest Protector','Back Protector'}
HELMETS = {'Trail','Full Face','Enduro','XC & Gravel','Urban','Helmets'}
SIZE_MAP = {'XXS':'XXS','XS':'XS','S':'S','M':'M','L':'L','XL':'XL','XXL':'XXL','2XL':'XXL','3XL':'3XL','XXXL':'3XL','4XL':'4XL',
            'SMALL':'S','MEDIUM':'M','LARGE':'L','X-LARGE':'XL','XLARGE':'XL','XX-LARGE':'XXL','XXLARGE':'XXL','SM':'S','MD':'M','LG':'L',
            'S/M':'S/M','M/L':'M/L','L/XL':'L/XL','XL/XXL':'XL/XXL','XS/S':'XS/S','XL/2XL':'XL/XXL','YS':'Youth S','YM':'Youth M','YL':'Youth L','YXL':'Youth XL'}
SIZE_RX = re.compile(r'(?<![\w/.-])(XXS|XS/S|XS|S/M|M/L|L/XL|XL/XXL|XL/2XL|XXXL|XXL|3XL|4XL|2XL|XL|XLARGE|X-LARGE|XX-LARGE|XXLARGE|SMALL|MEDIUM|LARGE|SM|MD|LG|YS|YM|YL|YXL|S|M|L)(?![\w/.-])', re.I)

def t(fam, val): return f"{fam}: {val}"

def size_tags(title, fam):
    out = set()
    for m in SIZE_RX.finditer(title):
        key = m.group(1).upper()
        if key in SIZE_MAP: out.add(t(fam, SIZE_MAP[key]))
    # "Size L" / "Size: L" forms handled above; also "55-59cm" helmets → keep as extra info
    return out

def gender_tags(title):
    tl = title.lower()
    if re.search(r"\b(women|womens|women's|woman|wmn|ladies|female|дамск)", tl): return {t('Gender', 'Дамски')}
    if re.search(r"\b(youth|kids|kid|junior|boys|girls|boys'|girls'|детск|child)", tl): return {t('Gender', 'Детски')}
    return set()

def mm(title, rx, fam, suffix=' mm'):
    m = re.search(rx, title, re.I)
    if not m: return set()
    val = next((g for g in m.groups() if g), None)
    return {t(fam, f"{val.replace(',', '.')}{suffix}")} if val else set()

def rules(p):
    title, typ = p['title'], p['productType'] or ''
    colls = {c['handle'] for c in p['collections']['nodes']}
    out = set()
    tl = title.lower()
    if typ in CLOTHING or typ in PROTECTION:
        out |= size_tags(title, 'Clothes Size') | gender_tags(title)
    if typ in HELMETS or 'helmet' in tl:
        out |= size_tags(title, 'Helmet Size') | gender_tags(title)
        m = re.search(r'(\d{2})\s*-\s*(\d{2})\s*cm', title)
        if m: out.add(t('Helmet Size', f"{m.group(1)}–{m.group(2)} cm"))
    if typ == 'Shoes' or 'shoe' in tl:
        m = re.search(r'EU\s?(\d{2}(?:\.5)?)', title)
        if m: out.add(t('Shoe Size', m.group(1)))
        out |= gender_tags(title)
    if typ == 'Grips':
        out |= mm(title, r'\b(2[89]|3[0-5])\s*mm\b', 'Diameter')
        if re.search(r'lock[\s-]?on', tl): out.add(t('Mount', 'Lock-on'))
        elif re.search(r'slip[\s-]?on|slide[\s-]?on|push[\s-]?on', tl): out.add(t('Mount', 'Slip-on'))
    if typ == 'Handlebar':
        m = re.search(r'(31\.8|35)\s*(?:mm)?\s*[x×]\s*(\d{3})', title) or re.search(r'(?:x|×)\s*(\d{3})', title)
        if m and m.lastindex == 2: out |= {t('Clamp', f"{m.group(1)} mm"), t('Width', f"{m.group(2)} mm")}
        else:
            out |= mm(title, r'\b(7[0-9]\d|8[0-4]\d)\s*(?:mm)?\b', 'Width')
            out |= mm(title, r'\b(31\.8|35)\s*mm', 'Clamp')
        out |= mm(title, r'\b(\d{1,2})\s*mm\s*rise', 'Rise')
        if 'carbon' in tl: out.add(t('Type', 'Карбон'))
        elif 'alloy' in tl or 'alu' in tl: out.add(t('Type', 'Алуминий'))
    if typ == 'Stem':
        m = re.search(r'\b(\d{2,3})\s*[xX]\s*(-?\d{1,2})\b', title)
        if m: out |= {t('Length', f"{m.group(1)} mm"), t('Rise', f"{m.group(2)}°")}
        else: out |= mm(title, r'\b(3[0-9]|4[0-9]|5[0-9]|6[0-9]|7[0-9]|8[0-9]|9[0-9]|1[0-2]\d)\s*mm\b', 'Length')
        out |= mm(title, r'\b(31\.8|35)\s*(?:mm)?\b', 'Clamp')
    if typ == 'Seatpost' or 'seatpost' in tl or 'dropper' in tl:
        out |= mm(title, r'\b(27\.2|30\.9|31\.6|34\.9)\b', 'Diameter')
        out |= mm(title, r'\b(1[0-9]\d|2[0-4]\d)\s*mm\b(?!\s*rise)', 'Travel')
    if typ == 'Chainrings':
        m = re.search(r'\b(\d{2})\s*T\b', title, re.I)
        if m: out.add(t('Number Of Teeth', m.group(1)))
        if re.search(r'\bcinch\b', tl): out.add(t('Mount', 'Cinch'))
        if re.search(r'direct mount|\bDM\b', title, re.I): out.add(t('Mount', 'Direct Mount'))
        if re.search(r'\bgxp\b', tl): out.add(t('Mount', 'GXP'))
        if re.search(r'shimano', tl): out.add(t('Compatibility', 'Shimano'))
        if re.search(r'\bsram\b', tl): out.add(t('Compatibility', 'SRAM'))
        if re.search(r'\b(104|96|110|130)\s*bcd|bcd\s*(104|96|110|130)', tl): out.add(t('Mount', 'BCD ' + (re.search(r'(104|96|110|130)', tl).group(1))))
        out.add(t('Shape', 'Овална' if 'oval' in tl else 'Кръгла'))
        out |= mm(title, r'boost\s*(\d)\s*mm|(\d)\s*mm\s*offset', 'Offset') if re.search(r'offset|boost', tl) else set()
    if typ == 'Cranks' or 'crank' in tl and typ != 'Other Accessories':
        out |= mm(title, r'\b(16[05]|17[05])\s*(?:mm)?\b', 'Crank Length')
    if typ == 'Brake Pads':
        for brand in ('Shimano','SRAM','Magura','Hope','Formula','TRP','Tektro','Hayes','Avid','Campagnolo','Bosch','Brembo'):
            if brand.lower() in tl: out.add(t('Compatibility', brand))
        for k, v in (('sinter', 'Синтеровани'), ('metal', 'Метални'), ('organic', 'Органични'), ('semi', 'Полу-метални'), ('e-bike', 'E-bike'), ('electric', 'E-bike'), ('race', 'Race'), ('performance', 'Performance')):
            if k in tl: out.add(t('Compound', v))
    if typ == 'Brake Discs' or 'rotor' in tl or 'brake disc' in tl:
        out |= mm(title, r'\b(140|160|180|200|203|220|223)\s*(?:mm)?\b', 'Diameter')
        if re.search(r'center\s*lock|centre\s*lock|\bCL\b', title, re.I): out.add(t('Mount', 'Centerlock'))
        elif re.search(r'6[\s-]*bolt|IS\b', title, re.I): out.add(t('Mount', '6 болта'))
    if typ == 'Bottom Brackets':
        for std in ('PF30','BB92','BB86','BB30','T47','BSA','PF92','BB107','BB104','DUB'):
            if std.lower() in tl: out.add(t('Standard', std))
        if 'threaded' in tl or 'bsa' in tl: out.add(t('Standard', 'BSA'))
        m = re.search(r'Ø\s*(24|29|30)|(24|29|30)\s*mm\s*axle', title, re.I)
        if m: out.add(t('Diameter', f"{m.group(1) or m.group(2)} mm"))
    if typ == 'Bearings':
        m = re.search(r'\b(\d{1,2}(?:\.\d)?)\s*[xX]\s*(\d{2})\s*[xX]\s*(\d{1,2}(?:\.\d)?)\b', title)
        if m: out.add(t('Bearing Size', f"{m.group(1)}x{m.group(2)}x{m.group(3)}"))
        m = re.search(r'\b(6[0-9]{3}|MR\s?\d{4,5}|R\d{1,2}|3[0-9]{3})\b', title)
        if m: out.add(t('Type', m.group(1).replace(' ', '')))
        if 'ceramic' in tl: out.add(t('Compound', 'Керамични'))
        elif 'max' in tl: out.add(t('Compound', 'MAX'))
    if typ == 'Spokes':
        out |= mm(title, r'\b(2[4-9]\d|30\d)\s*mm\b', 'Length')
        if 'j-bend' in tl or 'jbend' in tl: out.add(t('Spoke Type', 'J-Bend'))
        elif 'straight' in tl: out.add(t('Spoke Type', 'Straight pull'))
    if typ == 'Hubs':
        m = re.search(r'\b(100|110|135|142|148|157)\s*[xX]\s*(12|15|20|9)\b', title)
        if m: out.add(t('Spacing', f"{m.group(1)}x{m.group(2)}"))
        m = re.search(r'\b(2[048]|32|36)\s*H\b', title, re.I)
        if m: out.add(t('Holes', m.group(1)))
        if re.search(r'\bfront\b', tl): out.add(t('Position', 'Предна'))
        if re.search(r'\brear\b', tl): out.add(t('Position', 'Задна'))
        for fh in ('XD', 'MS', 'Micro Spline', 'HG', 'Shimano'):
            if fh.lower() in tl: out.add(t('Compatibility', 'Micro Spline' if fh in ('MS', 'Micro Spline') else fh))
    if typ == 'Axles':
        out |= mm(title, r'\b(1[4-9]\d|20\d)\s*mm\b', 'Length')
        for b in ('Rockshox','Fox','Orbea','Santa Cruz','Specialized','Trek','Giant','Canyon','YT','Commencal','Marzocchi','Manitou','DVO','Öhlins','Ohlins'):
            if b.lower() in tl: out.add(t('Compatibility', b))
        if 'front' in tl or 'fork' in tl: out.add(t('Position', 'Предна'))
        if 'rear' in tl: out.add(t('Position', 'Задна'))
    if typ == 'Pedals':
        if re.search(r'clip|spd|clipless', tl): out.add(t('Type', 'Clipless'))
        else: out.add(t('Type', 'Flat'))
        if 'nylon' in tl or 'composite' in tl or 'plastic' in tl: out.add(t('Compound', 'Найлон'))
        elif 'alloy' in tl or 'alu' in tl or 'cnc' in tl: out.add(t('Compound', 'Алуминий'))
    if typ == 'Tubeless Valves':
        out |= mm(title, r'\b(3[0-9]|4[0-9]|5[0-9]|6[0-9]|7[0-9]|8[0-9]|9[0-9]|1[0-2]\d)\s*mm\b', 'Length')
    if typ == 'Bottles':
        m = re.search(r'\b(4[05]0|5[05]0|6[05]0|7[05]0|8[05]0|950|1000)\b', title)
        if m: out.add(t('Volume', f"{m.group(1)} ml"))
    if typ == 'Lights':
        m = re.search(r'\b(\d{3,4})\s*(?:lumen|lm)\b', title, re.I) or re.search(r'\b(\d{3,4})\b', title)
        if m and 100 <= int(m.group(1)) <= 8000: out.add(t('Lumens', m.group(1)))
        if re.search(r'tail|rear|seemee|ktv|strip', tl): out.add(t('Position', 'Задна'))
        elif re.search(r'front|head|drive|monteer|ray|allty', tl): out.add(t('Position', 'Предна'))
    if typ in ('Skateboard', 'Complete', 'Deck'):
        m = re.search(r'\b(7\.\d{1,3}|8\.\d{1,3}|9\.\d{1,2})\b', title)
        if m: out.add(t('Deck Width', f'{m.group(1)}"'))
    if typ == 'Skateboard Wheels' or ('wheel' in tl and 'skate' in ' '.join(colls)):
        out |= mm(title, r'\b(5[0-9]|6[0-9])\s*mm\b', 'Diameter')
    if typ == 'Bikes' or 'bikes-od62' in colls or 'velosipedi-c59' in colls:
        m = re.search(r'\b(XS|SM|MD|LG|XL|XXL|S|M|L)\b(?=[^A-Za-z]|$)', title)
        if m: out.add(t('Frame Size', SIZE_MAP.get(m.group(1).upper(), m.group(1))))
        m = re.search(r'\b(4[6-9]|5[0-9]|6[0-2])\b(?=\s)', title)
        if m and not re.search(r'\b(XS|S|M|L|XL)\b', title): out.add(t('Frame Size', f"{m.group(1)} cm"))
        mk = re.search(r'\bMX\s*(20|24|26)\b', title, re.I)
        if mk: out.add(t('Wheel Size', mk.group(1) + '"'))
        elif re.search(r'\bMX\b|mullet', title, re.I): out.add(t('Wheel Size', 'MX (29/27.5)'))
        elif re.search(r'\b29\b', title): out.add(t('Wheel Size', '29"'))
        elif re.search(r'\b27\.5\b|\b275\b', title): out.add(t('Wheel Size', '27.5"'))
        elif re.search(r'\b(20|24|26)\b', title): out.add(t('Wheel Size', re.search(r'\b(20|24|26)\b', title).group(1) + '"'))
        if re.search(r'\b(rise|wild|gain|urrun|vibe|ebike|e-bike|heckler|bullit|levo|kenevo)\b', tl): out.add(t('Type', 'Електрически'))
        if 'frame set' in tl or 'frameset' in tl or 'frame kit' in tl: out.add(t('Type', 'Рамка'))
    if typ in ('Sunglasses', 'Ski Goggles', 'MTB Goggles', 'Goggles'):
        m = re.search(r'(polarized|photochromic|mirror|smoke|clear|blue|pink|green|purple|yellow|orange|gold|silver|bronze|red)[^|]*?lens', tl)
        if m: out.add(t('Lens', 'Поляризирани' if 'polar' in m.group(0) else m.group(1).capitalize()))
        if re.search(r'\bsmall\b', tl): out.add(t('Clothes Size', 'S'))
        if re.search(r'\blarge\b', tl): out.add(t('Clothes Size', 'L'))
    # options → tags (Size/Color) when present
    for o in p['options']:
        if o['name'] == 'Size':
            fam = 'Shoe Size' if typ == 'Shoes' else ('Helmet Size' if typ in HELMETS else 'Clothes Size')
            for v in o['values']: out.add(t(fam, SIZE_MAP.get(v.upper().strip(), v.strip())))
    return out

def main(apply=False):
    prods, c = [], None
    while True:
        d = gql('query($c:String){ products(first:250, after:$c){ pageInfo{hasNextPage endCursor} nodes{ id title productType tags options{name values} collections(first:6){nodes{handle}} } } }', {'c': c})['products']
        prods += d['nodes']
        if not d['pageInfo']['hasNextPage']: break
        c = d['pageInfo']['endCursor']
    changes, fam_stats = [], collections.Counter()
    for p in prods:
        keep = [x for x in p['tags'] if not (': ' in x and x.split(': ')[0] in MANAGED and x.split(': ')[0] not in ('Number Of Teeth','Frame Size','Wheel Size','Rise'))]
        # keep sync-provided Number Of Teeth / Frame Size / Wheel Size / Rise; add ours on top
        new = sorted(set(keep) | rules(p))
        if new != sorted(p['tags']): changes.append((p['id'], p['title'], new))
        for x in rules(p): fam_stats[x.split(': ')[0]] += 1
    print(f"products {len(prods)} · to update {len(changes)}")
    print('families:', fam_stats.most_common())
    if not apply:
        for pid, title, tags in changes[:25]: print('  ', title[:60], '→', [x for x in tags if x.split(': ')[0] in MANAGED][:6])
        return
    ok = 0
    for pid, title, tags in changes:
        d = gql('mutation($p:ProductUpdateInput!){ productUpdate(product:$p){ userErrors{ message } } }', {'p': {'id': pid, 'tags': tags}})
        if d['productUpdate']['userErrors']: print('fail', title[:50], d['productUpdate']['userErrors'])
        else: ok += 1
    print('updated', ok)

if __name__ == '__main__':
    main('--apply' in sys.argv)
