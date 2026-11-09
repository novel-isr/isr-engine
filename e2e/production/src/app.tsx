import ProductionView from './view.client';

export async function App({ url }: { url: URL }) {
  return (
    <html lang='en'>
      <head>
        <meta charSet='utf-8' />
        <title>Production regression fixture</title>
      </head>
      <body>
        <ProductionView route={url.pathname === '/article' ? 'Article' : 'Home'} />
      </body>
    </html>
  );
}
