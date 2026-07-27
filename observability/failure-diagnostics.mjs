import fs from 'node:fs/promises';
import path from 'node:path';

function safeSegment(value, fallback) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return cleaned || fallback;
}

function uniquePages(pages) {
  const seen = new Set();
  const result = [];

  for (const item of Array.isArray(pages) ? pages : []) {
    const page = item?.page;
    if (!page || seen.has(page)) continue;

    seen.add(page);
    result.push({
      name: safeSegment(item?.name, `page-${result.length + 1}`),
      page
    });
  }

  return result;
}

async function capturePage({
  page,
  pageName,
  diagnosticsDir
}) {
  const files = [];
  const errors = [];

  if (typeof page?.screenshot === 'function') {
    const screenshotPath = path.join(
      diagnosticsDir,
      `${pageName}.png`
    );

    try {
      await page.screenshot({
        path: screenshotPath,
        fullPage: true
      });
      files.push(screenshotPath);
    } catch (err) {
      errors.push({
        pageName,
        artifactType: 'screenshot',
        error: err?.message || String(err)
      });
    }
  } else {
    errors.push({
      pageName,
      artifactType: 'screenshot',
      error: 'page_screenshot_not_supported'
    });
  }

  if (typeof page?.content === 'function') {
    const htmlPath = path.join(
      diagnosticsDir,
      `${pageName}.html`
    );

    try {
      const html = await page.content();
      await fs.writeFile(
        htmlPath,
        String(html || ''),
        'utf8'
      );
      files.push(htmlPath);
    } catch (err) {
      errors.push({
        pageName,
        artifactType: 'html',
        error: err?.message || String(err)
      });
    }
  } else {
    errors.push({
      pageName,
      artifactType: 'html',
      error: 'page_content_not_supported'
    });
  }

  return {
    files,
    errors
  };
}

export async function captureFailureDiagnostics({
  diagnosticsRoot,
  entryName,
  pdfStem,
  attemptNumber,
  reason = 'failure',
  pages = []
}) {
  const availablePages = uniquePages(pages);

  if (!diagnosticsRoot || availablePages.length === 0) {
    return {
      captured: false,
      diagnosticsDir: null,
      reason: safeSegment(reason, 'failure'),
      files: [],
      errors: [],
      pageCount: 0
    };
  }

  const diagnosticsDir = path.join(
    diagnosticsRoot,
    'entries',
    safeSegment(entryName, 'entry'),
    safeSegment(pdfStem, 'pdf'),
    `attempt-${Math.max(1, Number(attemptNumber) || 1)}`,
    safeSegment(reason, 'failure')
  );

  await fs.mkdir(diagnosticsDir, {
    recursive: true
  });

  const files = [];
  const errors = [];

  for (const item of availablePages) {
    const captured = await capturePage({
      page: item.page,
      pageName: item.name,
      diagnosticsDir
    });

    files.push(...captured.files);
    errors.push(...captured.errors);
  }

  const metadataPath = path.join(
    diagnosticsDir,
    'diagnostics.json'
  );

  const metadata = {
    capturedAt: new Date().toISOString(),
    reason: safeSegment(reason, 'failure'),
    entryName: entryName || null,
    pdfStem: pdfStem || null,
    attemptNumber: Math.max(
      1,
      Number(attemptNumber) || 1
    ),
    pageCount: availablePages.length,
    files,
    errors
  };

  try {
    await fs.writeFile(
      metadataPath,
      JSON.stringify(metadata, null, 2),
      'utf8'
    );
    files.push(metadataPath);
  } catch (err) {
    errors.push({
      pageName: null,
      artifactType: 'metadata',
      error: err?.message || String(err)
    });
  }

  return {
    captured: files.length > 0,
    diagnosticsDir,
    reason: metadata.reason,
    files,
    errors,
    pageCount: availablePages.length
  };
}