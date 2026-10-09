import { IsNotEmpty, IsString, Matches } from 'class-validator';

/**
 * POST /domains — architecture/api-contract.md §6. `domainName` is the only
 * input; `verification_token` and `verification_status = 'pending'`
 * (control.domains' own DEFAULT) are generated/left server-side
 * (architecture/domain-and-email-flow.md step 1).
 *
 * The regex is a deliberately permissive hostname-shape check — labels of
 * alphanumerics/hyphens (no leading/trailing hyphen per label), at least one
 * dot — that rejects obvious garbage ("not a domain at all") before a DNS
 * lookup is ever attempted. It's not a full RFC 1035 validator, and doesn't
 * need to be: a syntactically-plausible but nonexistent domain still fails
 * verification normally, the same as any other unverifiable domain.
 */
export class CreateDomainDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/, {
    message: 'domainName must be a valid domain name (e.g. acme.com)',
  })
  domainName!: string;
}
