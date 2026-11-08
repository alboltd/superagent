const fs = require('node:fs');
const path = require('node:path');
const browserify = require('browserify');
const getPort = require('get-port');
const { chromium, firefox, webkit } = require('playwright');

async function main() {
  const clientDir = path.join(__dirname, '..', 'client');
  const files = fs.readdirSync(clientDir)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => path.join(clientDir, name));
  const bundle = await new Promise((resolve, reject) => {
    browserify(files, { debug: true })
      .transform('babelify', { configFile: path.join(__dirname, '..', '..', '.dist.babelrc') })
      .bundle((error, output) => error ? reject(error) : resolve(output));
  });
  const port = await getPort();
  process.env.ZUUL_PORT = String(port);
  const { app, server } = require('./server');
  const mocha = fs.readFileSync(require.resolve('mocha/mocha.js'));
  app.get('/__browser_test__/mocha.js', (request, response) => {
    response.set('Content-Type', 'application/javascript').send(mocha);
  });
  app.get('/__browser_test__/bundle.js', (request, response) => {
    response.set('Content-Type', 'application/javascript').send(bundle);
  });
  app.get('/__browser_test__/', (request, response) => {
    response.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Superagent browser tests</title></head><body>
<div id="mocha"></div>
<script src="/__browser_test__/mocha.js"></script>
<script>mocha.setup('bdd'); window.__testFailures = [];</script>
<script src="/__browser_test__/bundle.js"></script>
<script>
const runner = mocha.run(function (failures) {
  window.__testResult = { failures, stats: runner.stats, details: window.__testFailures };
});
runner.on('fail', function (test, error) {
  window.__testFailures.push(test.fullTitle() + ': ' + error.message);
});
</script></body></html>`);
  });

  let browser;
  try {
    if (!server.listening) {
      await new Promise((resolve) => server.once('listening', resolve));
    }
    const engines = { chromium, firefox, webkit };
    const engineName = process.env.BROWSER_ENGINE || 'chromium';
    if (!engines[engineName]) throw new Error(`Unsupported browser engine: ${engineName}`);
    browser = await engines[engineName].launch({
      headless: true,
      ...(engineName === 'chromium' && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/__browser_test__/`);
    await page.waitForFunction(() => window.__testResult !== undefined, { timeout: 120_000 });
    const result = await page.evaluate(() => window.__testResult);
    console.log(`${engineName} browser tests: ${result.stats.passes} passed, ${result.stats.failures} failed`);
    for (const detail of [...pageErrors, ...result.details]) console.error(detail);
    if (result.failures || pageErrors.length) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
