import { describe, expect, it } from 'vitest';
import { mailingAddressIssue, MAILING_ADDRESS_HELP, usableMailingAddress } from '@/lib/mailing-address';

describe('the mailing address printed in automatic emails', () => {
  it('accepts US postal addresses in the forms people really type them', () => {
    for (const a of [
      // With commas, the usual way.
      '500 Bayshore Blvd, Suite 210, Tampa, FL 33606',
      'PO Box 123, Miami, FL 33101',
      'P.O. Box 4500, Allen, TX 75013-4500',
      "1200 O'Neil St. #4, St. Petersburg, FL 33701",
      '77 N.W. 5th Ave, Apt 3/B, Cañon City, CO 81212',
      '9 Main St, c/o Smith & Co, Dover, DE 19901',
      '150 Calle A, Urb Las Gladiolas, San Juan, PR 00926',
      'Urb Las Gladiolas, 150 Calle A, San Juan, PR 00926',
      'One Financial Plaza, Hartford, CT 06103',
      'Eleven Times Square, New York, NY 10036',
      'Suite 210, 500 Bayshore Blvd, Tampa, FL 33606',
      'RR 2 Box 152, Wibaux, MT 59353',
      'N6W23001 Bluemound Rd, Waukesha, WI 53188', // a grid address: the house number starts with a letter
      '37-10 114th St, Corona, NY 11368',
      '91-1001 Fort Weaver Rd, Ewa Beach, HI 96706',
      '1600 Pennsylvania Ave NW, Washington, DC 20500',
      '1 Infinite Loop, Cupertino, ca 95014, USA',
      'Unit 2050 Box 4190, APO AP 96278-2050',
      // Without commas: the Postal Service's own form, and an address pasted from three lines.
      '500 Bayshore Blvd Suite 210 Tampa FL 33606',
      '500 BAYSHORE BLVD STE 210 TAMPA FL 33606-1234',
      '1234 N Main St Salt Lake City UT 84101',
      '4500 North Federal Highway Suite 200 Fort Lauderdale FL 33308',
      // Long street names.
      '3000 E Dr Martin Luther King Jr Blvd, Tampa, FL 33610',
      '2000 Dr Martin Luther King Jr St N, St. Petersburg, FL 33704',
      '1 Dr. Martin Luther King Jr. Blvd, Newark, NJ 07102',
      '1234 Martin Luther King Jr Blvd Suite 300, Chapel Hill, NC 27514',
      '12345 US Highway 19 N Suite 200, Clearwater, FL 33764',
      '2201 FM 1960 Rd W Ste 100, Houston, TX 77090',
      '1251 Avenue of the Americas Fl 20, New York, NY 10020',
      '100 West Old Country Road Suite 200, Hicksville, NY 11801',
      // The state written out, or with full stops; a full stop at the end; the country after the ZIP code.
      '500 Bayshore Blvd, Tampa, Florida 33606',
      '4521 Hwy 6 S, Houston, Texas 77083',
      '350 Fifth Ave, New York, New York 10118',
      '1600 Pennsylvania Ave NW, Washington, D.C. 20500',
      '100 1st St., Apt. 3B, Brooklyn, N.Y. 11201',
      '500 Bayshore Blvd, Tampa, FL. 33606',
      '500 Bayshore Blvd, Tampa, FL 33606.',
      '500 Bayshore Blvd, Tampa, FL 33606, U.S.A.',
      // Typed on a phone or a Mac.
      '1200 O’Neil St, St. Petersburg, FL 33701',
      '12–14 Main St, Boston, MA 02110',
      // Boxes, private mailboxes, rural routes, units first.
      'Post Office Box 123, Miami, FL 33101',
      'POB 123, Miami, FL 33101',
      'P.O.B. 123, Miami, FL 33101',
      'P.O.Box 123, Miami, FL 33101',
      'PO Drawer 1234, Tyler, TX 75710',
      'PMB 456, 1234 Main St, Wilmington, DE 19801',
      'R.R. 2 Box 152, Wibaux, MT 59353',
      'Rural Route 2, Box 152, Wibaux, MT 59353',
      'HCR 68 Box 23A, Kingston, AR 72742',
      'Apt 4B, 200 W 57th St, New York, NY 10019',
      'Floor 34, 350 Fifth Ave, New York, NY 10118',
      'Bldg 4, 100 Main St, Austin, TX 78701',
      '#210, 500 Bayshore Blvd, Tampa, FL 33606',
      'c/o Smith & Co, 9 Main St, Dover, DE 19901',
      // Puerto Rico, where the street word comes first.
      'Calle Loíza 1234, San Juan, PR 00911',
      'Ave. Ponce de Leon 1250, Santurce, PR 00907',
      'Cond. El Monte Sur, Apt 123, San Juan, PR 00918',
      'Carr 2 Km 15.2, Bayamon, PR 00961',
      'Apartado 9023431, San Juan, PR 00902',
      'Mile 1422 Alaska Hwy, Delta Junction, AK 99737',
      'Pier 39, Suite 201, San Francisco, CA 94133',
      '100\u00a0Main St, Boston, MA 02110', // a no-break space, as a web page copies it
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
      '500 Bayshore Blvd, Tampa, FL', '500 Bayshore Blvd, Tampa, ZZ 33606', '33606 FL, Tampa, 500 Bayshore Blvd',
      `${'1 Main St, '.repeat(20)}Tampa, FL 33606`,
      // A message with a house number in front and a state at the end.
      '1 we fix your credit in 30 days or you pay nothing at all Tampa FL 33606',
      '1 Main St, Reply YES to claim your refund, Tampa, FL 33606',
    ]) expect(mailingAddressIssue(a), a).not.toBeNull();
  });

  it('refuses a phone number, which is the start of a message and never part of an address', () => {
    for (const a of [
      '9 Main St, your account is on hold, call 800 555 0100, DE 19901',
      '800-555-0100 call us now, Tampa, FL 33606',
      '1-800-555-0100 call now, Tampa, FL 33606',
      '1 Main St, Call (800) 555-0100 today, Tampa, FL 33606',
      '1 Your SSN is suspended, call 800 555 0100, FL 33606',
      '100 percent off, call 8005550100, FL 33606',
    ]) expect(mailingAddressIssue(a), a).toBe(`A mailing address cannot contain a phone number. ${MAILING_ADDRESS_HELP}`);
    // A ZIP+4 is not a phone number.
    expect(mailingAddressIssue('PO Box 1234, Allen, TX 75013-4500')).toBeNull();
  });

  it('refuses a promise the claims check would refuse in every email', () => {
    expect(mailingAddressIssue('100 point score increase guaranteed, Tampa, FL 33606')).toMatch(/^A mailing address cannot carry a promise or an offer: Results cannot be guaranteed\./);
    expect(mailingAddressIssue('5 stars, we delete all negatives, FL 33606')).toMatch(/^A mailing address cannot carry a promise or an offer/);
  });

  it('says what is wrong in words the person can act on', () => {
    expect(mailingAddressIssue('500 Bayshore Blvd, Tampa, FL 33606 www.example.com')).toMatch(/^A mailing address cannot contain a web address\./);
    expect(mailingAddressIssue('1 Main St, Reply YES to claim your refund, Tampa, FL 33606')).toMatch(/^Each part of the address should be short/);
    expect(MAILING_ADDRESS_HELP).toContain('from the street number or PO Box to the state and ZIP code');
  });

  it('reads a saved value that fails the rule as no address at all', () => {
    expect(usableMailingAddress('  500 Bayshore Blvd, Suite 210, Tampa, FL 33606 ')).toBe('500 Bayshore Blvd, Suite 210, Tampa, FL 33606');
    expect(usableMailingAddress('x')).toBe('');
    expect(usableMailingAddress(null)).toBe('');
  });
});
