// Runs a Postman collection with Newman using the RBL client certificate from .env
// and writes a readable report of every request and the bank's response.
//
// Usage:
//   npm i -D newman
//   node scripts/run-postman-tests.js [collection.json]
//
// The certificate passphrase is read from .env in memory only; it is never written to disk.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const newman = require('newman');

const collectionFile = path.resolve(process.argv[2] || 'Disbursement_Perfect_Structure.postman_collection.json');
const certPath = path.resolve(process.env.RBL_CERT_PATH || 'rbl_cert.pfx');
const reportDir = path.resolve('generated-exports');
const reportFile = path.join(reportDir, `postman-report-${Date.now()}.md`);

if (!fs.existsSync(certPath)) {
  console.error(`Client certificate not found: ${certPath}`);
  process.exit(1);
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : '';
};

newman.run(
  {
    collection: require(collectionFile),
    sslClientCertList: [
      {
        name: 'rbl',
        matches: ['https://apideveloper.rbl.bank.in/*'],
        pfx: { src: certPath },
        passphrase: process.env.RBL_CERT_PASSPHRASE,
      },
    ],
    delayRequest: 500,
    timeoutRequest: 90000,
    reporters: ['cli'],
  },
  (err, summary) => {
    if (err) {
      console.error('Newman failed to run:', err);
      process.exit(1);
    }

    // Newman logs an extra execution for the pre-request pm.sendRequest; keep one row per request.
    const executions = summary.run.executions.filter(
      (ex, i, all) => !(all[i + 1] && all[i + 1].item.id === ex.item.id && all[i + 1].cursor.position === ex.cursor.position)
    );

    const rows = executions.map((ex) => {
      const name = [ex.item.parent() && ex.item.parent().name, ex.item.name].filter(Boolean).join(' / ');
      if (!ex.response) return { name, code: 'ERR', status: '', description: ex.requestError ? ex.requestError.message : 'no response' };
      const body = ex.response.text();
      return {
        name,
        code: ex.response.code,
        status: tag(body, 'status'),
        description: tag(body, 'description') || tag(body, 'result') || body.replace(/\s+/g, ' ').slice(0, 800),
      };
    });

    const lines = [
      `# Postman run: ${path.basename(collectionFile)}`,
      '',
      `Run at ${new Date().toISOString()} | ${rows.length} requests`,
      '',
      '| # | Request | HTTP | Status | Response |',
      '|---|---|---|---|---|',
      ...rows.map((r, i) => `| ${i + 1} | ${r.name} | ${r.code} | ${r.status} | ${String(r.description).replace(/\|/g, '\\|')} |`),
    ];
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(reportFile, lines.join('\n') + '\n');
    console.log(`\nReport written to ${reportFile}`);
  }
);
