import { routes } from './routes';

export async function App({ url }: { url: URL }) {
  const delayMs = Number(url.searchParams.get('delay') ?? 0);
  if (Number.isFinite(delayMs) && delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  return (
    <html lang='en'>
      <head>
        <meta charSet='utf-8' />
        <title>Development CSS lifecycle</title>
      </head>
      <body>
        {routes({
          pathname: url.pathname,
          searchParams: url.searchParams,
        })}
      </body>
    </html>
  );
}
