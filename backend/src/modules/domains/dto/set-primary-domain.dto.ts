import { IsBoolean } from 'class-validator';

/**
 * PATCH /domains/{domainId} — architecture/api-contract.md §6:
 * `{ "isPrimary": true }`. `false` is also accepted (clears primary without
 * necessarily naming a replacement) — the contract's example only shows the
 * `true` case, but nothing in it forbids the symmetric unset, and
 * DomainsService.setPrimary handles both.
 */
export class SetPrimaryDomainDto {
  @IsBoolean()
  isPrimary!: boolean;
}
