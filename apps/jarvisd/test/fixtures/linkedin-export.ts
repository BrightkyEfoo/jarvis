import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A real .xlsx (zip of XML) with LinkedIn's TOP POSTS layout: two tables side by side. */
export function makeExport(dir: string): string {
  const root = join(dir, 'x');
  mkdirSync(join(root, 'xl', 'worksheets'), { recursive: true });
  mkdirSync(join(root, 'xl', '_rels'), { recursive: true });
  writeFileSync(
    join(root, 'xl', 'workbook.xml'),
    '<workbook xmlns:r="r"><sheets><sheet name="TOP POSTS" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  writeFileSync(
    join(root, 'xl', '_rels', 'workbook.xml.rels'),
    '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  const strings = ['Post URL', 'Post publish date', 'Engagements', 'Impressions'];
  const urls = [1, 2, 3, 4, 5].map(
    (n) => `https://www.linkedin.com/feed/update/urn:li:activity:${n}`,
  );
  writeFileSync(
    join(root, 'xl', 'sharedStrings.xml'),
    `<sst>${[...strings, ...urls].map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
  );
  const s = (ref: string, i: number) => `<c r="${ref}" t="s"><v>${i}</v></c>`;
  const n = (ref: string, v: string | number) => `<c r="${ref}"><v>${v}</v></c>`;
  const rows = [
    `<row r="1">${s('A1', 0)}${s('B1', 1)}${s('C1', 2)}${s('E1', 0)}${s('F1', 1)}${s('G1', 3)}</row>`,
    ...[0, 1, 2, 3, 4].map(
      (i) =>
        `<row r="${i + 2}">${s(`A${i + 2}`, 4 + i)}<c r="B${i + 2}" t="inlineStr"><is><t>10/${i + 1}/2026</t></is></c>${n(`C${i + 2}`, 10 + i)}${s(`E${i + 2}`, 4 + i)}${n(`F${i + 2}`, 46296 + i)}${n(`G${i + 2}`, [1000, 1100, 900, 3000, 300][i] ?? 0)}</row>`,
    ),
  ];
  writeFileSync(
    join(root, 'xl', 'worksheets', 'sheet1.xml'),
    `<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`,
  );
  const file = join(dir, 'Content_2026-10-01_2026-10-05_BrightkyEfoo.xlsx');
  execFileSync('/usr/bin/zip', ['-q', '-r', file, 'xl'], { cwd: root });
  return file;
}
