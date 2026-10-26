import { parseCsv, parseTradelineCsv, CSV_TEMPLATE } from '@/lib/import';

test('csv quoting', () => {
  expect(parseCsv('a,"b,""c""",d\r\n1,2,3\n')).toEqual([
    ['a', 'b,"c"', 'd'],
    ['1', '2', '3'],
  ]);
});

test('template parses; account number reduced to last4', () => {
  const r = parseTradelineCsv(CSV_TEMPLATE);
  expect(r.errors).toEqual([]);
  expect(r.rows[0]).toMatchObject({
    account_last4: '1234',
    balance_cents: 54025,
    bureau: 'experian',
  });
  expect(JSON.stringify(r)).not.toContain('00001234');
});

test('errors reported per row', () => {
  const r = parseTradelineCsv(
    'bureau,creditor_name,balance\nfoo,X,1\nequifax,Y,abc\nequifax,Z,"$1,200.50"\n',
  );
  expect(r.errors).toHaveLength(2);
  expect(parseTradelineCsv('creditor_name\nX').errors[0]).toMatch(/bureau/);
});
