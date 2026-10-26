import { generateBureauLetter } from '@/lib/letters';

export default function Letters() {
  const sample = generateBureauLetter({
    clientName: 'Jane Doe',
    clientAddress: '1 Main St, Anytown, USA',
    bureau: 'experian',
    creditor: 'Example Bank',
    accountLast4: '1234',
    reason: 'This account is not mine.',
    date: new Date(),
  });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Letters</h1>
      <p>Sample §611 letter preview:</p>
      <pre className="whitespace-pre-wrap border p-4 text-sm">{sample}</pre>
    </div>
  );
}
