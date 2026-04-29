/**
 * Pages Function: reverse proxy for sub-trip sites
 * Route: /app/{project}/{...path}
 *
 * Keeps everything under trip-hub.pages.dev so iOS PWA stays full-screen
 * when navigating from trip-hub into individual trip sites.
 */

const ROUTES = {
  'palau-trip': 'https://palau-trip.pages.dev',
  'bali-trip':  'https://bali-trip-5n6.pages.dev',
};

export async function onRequest(context) {
  const { request, env, params } = context;
  const segments = params.catchall || [];

  if (segments.length === 0) {
    return new Response('Not found', { status: 404 });
  }

  const project = segments[0];
  const origin = ROUTES[project];
  if (!origin) {
    return new Response('Unknown project: ' + project, { status: 404 });
  }

  const subPath = '/' + segments.slice(1).join('/');
  const url = new URL(request.url);
  const upstreamUrl = origin + subPath + url.search;

  const headers = new Headers();
  headers.set('Accept', request.headers.get('accept') || '*/*');
  headers.set('Accept-Language', request.headers.get('accept-language') || 'en');
  const ua = request.headers.get('user-agent');
  if (ua) headers.set('User-Agent', ua);

  const clientId = env.CF_ACCESS_CLIENT_ID;
  const clientSecret = env.CF_ACCESS_CLIENT_SECRET;
  if (clientId && clientSecret) {
    headers.set('CF-Access-Client-Id', clientId);
    headers.set('CF-Access-Client-Secret', clientSecret);
  }

  let resp = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    redirect: 'manual',
  });

  let redirects = 0;
  while ((resp.status === 301 || resp.status === 302 || resp.status === 307 || resp.status === 308) && redirects < 5) {
    const location = resp.headers.get('location');
    if (!location) break;
    const redirectUrl = new URL(location, upstreamUrl);
    const redirectHeaders = new Headers(headers);
    if (clientId && clientSecret) {
      redirectHeaders.set('CF-Access-Client-Id', clientId);
      redirectHeaders.set('CF-Access-Client-Secret', clientSecret);
    }
    resp = await fetch(redirectUrl.toString(), {
      method: 'GET',
      headers: redirectHeaders,
      redirect: 'manual',
    });
    redirects++;
  }

  const contentType = resp.headers.get('content-type') || '';
  const prefix = '/app/' + project;

  if (contentType.includes('text/html')) {
    let html = await resp.text();
    html = rewriteAbsolutePaths(html, prefix);
    html = rewriteFullUrls(html);
    const newHeaders = new Headers(resp.headers);
    newHeaders.set('content-type', contentType);
    newHeaders.delete('content-length');
    newHeaders.set('Cache-Control', 'no-store');
    newHeaders.delete('x-frame-options');
    newHeaders.delete('content-security-policy');
    newHeaders.delete('set-cookie');
    return new Response(html, { status: resp.status, headers: newHeaders });
  }

  const newHeaders = new Headers(resp.headers);
  newHeaders.set('Cache-Control', 'no-store');
  newHeaders.delete('set-cookie');
  return new Response(resp.body, { status: resp.status, headers: newHeaders });
}

function rewriteAbsolutePaths(html, prefix) {
  return html.replace(
    /((?:src|href|action)\s*=\s*["'])\/(?!\/|app\/)/gi,
    '$1' + prefix + '/'
  );
}

function rewriteFullUrls(html) {
  for (const [name, origin] of Object.entries(ROUTES)) {
    const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(
      new RegExp('((?:src|href|action)\\s*=\\s*["\'])' + escaped + '(/[^"\']*|/?)', 'gi'),
      '$1/app/' + name + '$2'
    );
  }
  return html;
}
