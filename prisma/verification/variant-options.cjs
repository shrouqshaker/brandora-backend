const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const constraint = 'ProductVariant_parent_optionValues_key';
const insert =
  'INSERT INTO "ProductVariant" (id,"businessId","catalogItemId",sku,"optionValues","updatedAt") VALUES ($1,$2,$3,NULL,$4::jsonb,now())';
const values = (business, parent, options) => [
  randomUUID(),
  business,
  parent,
  options,
];
async function duplicate(db, sql, args) {
  await assert.rejects(
    db.query(sql, args),
    (error) => error.code === '23505' && error.constraint === constraint,
  );
}

async function verifyVariantOptions({
  db,
  a,
  b,
  item,
  other,
  laterItem,
  concurrentUnique,
}) {
  const first = values(a, item, '{"color":"red","size":"XL"}');
  await db.query(insert, first);
  await duplicate(
    db,
    insert,
    values(a, item, '{ "size": "XL", "color": "red" }'),
  );
  await db.query(insert, values(a, laterItem, '{"size":"XL","color":"red"}'));
  await db.query(insert, values(b, other, '{"size":"XL","color":"red"}'));
  await db.query('UPDATE "ProductVariant" SET "isActive"=false WHERE id=$1', [
    first[0],
  ]);
  await duplicate(db, insert, values(a, item, '{"size":"XL","color":"red"}'));

  for (const [original, equal] of [
    [
      '{"fixture":"nested","value":{"a":1,"b":2}}',
      '{"value":{"b":2,"a":1},"fixture":"nested"}',
    ],
    ['{"fixture":"number","value":1}', '{"value":1.00,"fixture":"number"}'],
    ['{}', ' { } '],
  ]) {
    await db.query(insert, values(a, item, original));
    await duplicate(db, insert, values(a, item, equal));
  }
  // JSONB type, null/missing and array order distinctions remain meaningful.
  for (const option of [
    '{"fixture":"number","value":"1"}',
    '{"fixture":"null"}',
    '{"fixture":"null","value":null}',
    '{"fixture":"array","value":[1,2]}',
    '{"fixture":"array","value":[2,1]}',
  ]) {
    await db.query(insert, values(a, item, option));
  }
  const changing = values(a, item, '{"fixture":"before-update"}');
  await db.query(insert, changing);
  await duplicate(
    db,
    'UPDATE "ProductVariant" SET "optionValues"=$1::jsonb WHERE id=$2',
    ['{"size":"XL","color":"red"}', changing[0]],
  );

  await concurrentUnique(
    insert,
    values(a, item, '{"fixture":"concurrent-insert","a":1,"b":2}'),
    values(a, item, '{"b":2,"a":1,"fixture":"concurrent-insert"}'),
    constraint,
  );
  const updateA = values(a, item, '{"fixture":"update-a"}');
  const updateB = values(a, item, '{"fixture":"update-b"}');
  await db.query(insert, updateA);
  await db.query(insert, updateB);
  await concurrentUnique(
    'UPDATE "ProductVariant" SET "optionValues"=$1::jsonb WHERE id=$2',
    ['{"fixture":"concurrent-update","a":1,"b":2}', updateA[0]],
    ['{"b":2,"a":1,"fixture":"concurrent-update"}', updateB[0]],
    constraint,
  );

  const countBefore = (
    await db.query('SELECT count(*)::int AS n FROM "ProductVariant"')
  ).rows[0].n;
  await assert.rejects(
    db.query(
      insert,
      values(
        a,
        item,
        JSON.stringify({ large: randomBytes(12000).toString('hex') }),
      ),
    ),
    (error) => error.code === '54000',
  );
  assert.equal(
    (await db.query('SELECT count(*)::int AS n FROM "ProductVariant"')).rows[0]
      .n,
    countBefore,
  );
  console.log(
    'PASS: option uniqueness rejects reordered/nested/numeric-equivalent duplicates, empty and inactive duplicates, and insert/update races; permits reuse across parents/tenants; preserves JSONB type/null/array distinctions; oversized index entries fail atomically.',
  );
}

async function verifyForwardUpgrade({ db, root, foundation }) {
  const migrationsRoot = path.join(root, 'prisma/migrations');
  for (const name of fs
    .readdirSync(migrationsRoot)
    .filter(
      (name) =>
        name <= foundation &&
        fs.existsSync(path.join(migrationsRoot, name, 'migration.sql')),
    )
    .sort()) {
    await db.query(
      fs.readFileSync(path.join(migrationsRoot, name, 'migration.sql'), 'utf8'),
    );
  }
  const business = randomUUID(),
    parent = randomUUID();
  await db.query(
    'INSERT INTO "Business" (id,name,"updatedAt") VALUES ($1,\'Forward fixture\',now())',
    [business],
  );
  await db.query(
    'INSERT INTO "CatalogItem" (id,"businessId",name,"updatedAt") VALUES ($1,$2,\'Forward fixture\',now())',
    [parent, business],
  );
  const first = values(business, parent, '{"color":"red","size":"XL"}');
  const second = values(business, parent, '{"size":"XL","color":"red"}');
  await db.query(insert, first);
  await db.query(insert, second);
  const forward = fs.readFileSync(
    path.join(
      migrationsRoot,
      '20261027010000_unique_variant_option_values/migration.sql',
    ),
    'utf8',
  );
  const snapshot = () => db.query('SELECT * FROM "ProductVariant" ORDER BY id');
  const before = (await snapshot()).rows;
  await assert.rejects(
    db.query(forward),
    (error) =>
      error.code === 'P0001' &&
      /duplicate option combinations/.test(error.message),
  );
  await db.query('ROLLBACK');
  assert.deepEqual((await snapshot()).rows, before);
  assert.equal(
    (
      await db.query('SELECT to_regclass($1) AS idx', [
        `public."${constraint}"`,
      ])
    ).rows[0].idx,
    null,
  );
  // Resolve only this disposable fixture explicitly, without deleting records.
  await db.query(
    'UPDATE "ProductVariant" SET "optionValues"=\'{"size":"XXL","color":"red"}\' WHERE id=$1',
    [second[0]],
  );
  const resolved = (await snapshot()).rows;
  await db.query(forward);
  assert.deepEqual((await snapshot()).rows, resolved);
  await duplicate(
    db,
    insert,
    values(business, parent, '{"size":"XL","color":"red"}'),
  );
  console.log(
    'PASS: forward migration aborts atomically on preexisting reordered duplicates; preserves every row; succeeds after explicit fixture resolution without deleting data.',
  );
}

module.exports = { verifyVariantOptions, verifyForwardUpgrade };
