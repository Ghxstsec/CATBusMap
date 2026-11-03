# Bus Penedès · Horaris

Web app (PWA) con el mapa, las paradas, las líneas y los horarios de **todos los autobuses
interurbanos de Cataluña**, con acceso rápido a **Autocars del Penedès**. Es una app no oficial.

- Mapa de paradas y recorridos de cada línea
- Próximas salidas por parada, con cuenta atrás, y horario completo de cualquier día
- Horario de cada línea por sentido y de cada expedición parada a parada
- Posición **estimada** de los buses en ruta (calculada a partir del horario; no hay GPS público)
- Ruta A → B con buses directos
- Favoritos, "paradas cercanas", castellano/català, tema claro/oscuro
- Se puede instalar en el móvil y funciona sin conexión con lo ya visitado

## Datos

GTFS de la Generalitat de Catalunya (Mou-te):
<https://territori.gencat.cat/web/.content/home/serveis/visors-cartografia/bases-cartografiques/infraestructures-mobilitat/autobusos-interurbans/busos-interurbans-GTFS.zip>

`scripts/build_data.py` lo descarga y lo convierte en JSON pequeños dentro de `public/data/`
(sin dependencias, solo Python 3). GitHub Actions lo vuelve a generar cada día.

## Desarrollo local

```bash
python3 scripts/build_data.py
cd public && python3 -m http.server 8765
# abre http://localhost:8765
```

## Despliegue (Cloudflare Pages, gratis)

1. Crea el proyecto una vez: `npx wrangler login && npx wrangler pages project create catbusmap --production-branch=main`
2. En Cloudflare, crea un API token con el permiso *Cloudflare Pages: Edit*.
3. En GitHub, ve a *Settings → Secrets and variables → Actions* y añade
   `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`.
4. Haz push a `main`. La web queda en `https://catbusmap.pages.dev`.
