import { describe, expect, it } from 'vitest';
import { mailingAddressIssue, usableMailingAddress } from '@/lib/mailing-address';

describe('the mailing address printed in automatic emails', () => {
  it('accepts ordinary US postal addresses', () => {
    for (const a of [
      '500 Bayshore Blvd, Suite 210, Tampa, FL 33606',
      'PO Box 123, Miami, FL 33101',
      'P.O. Box 4500, Allen, TX 75013-4500',
      "1200 O'Neil St. #4, St. Petersburg, FL 33701",
      '77 N.W. 5th Ave, Apt 3/B, Cañon City, CO 81212',
      '9 Main St, c/o Smith & Co, Dover, DE 19901',
      '150 Calle A, Urb Las Gladiolas, San Juan, PR 00926',
      'Urb Las Gladiolas, 150 Calle A, San Juan, PR 00926',
      'One Financial Plaza, Hartford, CT 06103',
      'Suite 210, 500 Bayshore Blvd, Tampa, FL 33606',
      'RR 2 Box 152, Wibaux, MT 59353',
      'N6W23001 Bluemound Rd, Waukesha, WI 53188', // a grid address: the house number starts with a letter
      '37-10 114th St, Corona, NY 11368',
      '1600 Pennsylvania Ave NW, Washington, DC 20500',
      '1 Infinite Loop, Cupertino, ca 95014, USA',
      'Unit 2050 Box 4190, APO AP 96278-2050',
    ]) expect(mailingAddressIssue(a), a).toBeNull();
  });

  it('refuses anything that is not shaped like an address', () => {
    for (const a of [
      '', '   ', 'x', 'Tampa, FL', '500 Bayshore Blvd, Tampa, FL', // nothing, too short, no ZIP code
      'URGENT: your escrow account is on hold. Sign in at https://secure-escrow-verify.example/login today or the closing is cancelled.',
      'Visit best-credit-fix.example 33606 for our offer',
      '500 Bayshore Blvd, Tampa, FL 33606 www.example.com',
      '500 Bayshore Blvd, Tampa, FL 33606! Call now',
      '500 Bayshore Blvd\nTampa, FL 33606',
      '<b>500 Bayshore Blvd, Tampa, FL 33606</b>',
      'As we discussed at the expo most local agents already use us 33606',
      'Your account is on hold, call 800 555 0100, ref 33606', // five digits, but it does not end with a state and a ZIP code
      'Call us today about your account, FL500 Bayshore Blvd, Suite 210, Tampa, FL 33606', // an address with a message in front of it
      'Smith & Co, 9 Main St, Dover, DE 19901', // the business name is printed before the address already
      '500 Bayshore Blvd, Tampa, Florida 33606', '500 Bayshore Blvd, Tampa, FL', '500 Bayshore Blvd, Tampa, ZZ 33606', '33606 FL, Tampa, 500 Bayshore Blvd',
      `${'1 Main St, '.repeat(20)}Tampa, FL 33606`,
    ]) expect(mailingAddressIssue(a), a).not.toBeNull();
  });

  it('reads a saved value that fails the rule as no address at all', () => {
    expect(usableMailingAddress('  500 Bayshore Blvd, Suite 210, Tampa, FL 33606 ')).toBe('500 Bayshore Blvd, Suite 210, Tampa, FL 33606');
    expect(usableMailingAddress('x')).toBe('');
    expect(usableMailingAddress(null)).toBe('');
  });
});
