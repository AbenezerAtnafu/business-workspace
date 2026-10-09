import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

// Request body per architecture/api-contract.md §2 ("Owner signup").
export class CreateOrganizationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  organizationName!: string;

  @IsEmail()
  ownerContactEmail!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  ownerName!: string;

  // planning/business-rules-and-defaults.md ("Authentication"): minimum 10
  // characters, length favored over forced composition rules.
  @IsString()
  @MinLength(10)
  @MaxLength(256)
  password!: string;
}
