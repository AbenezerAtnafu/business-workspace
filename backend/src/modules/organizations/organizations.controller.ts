import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { OrganizationsService } from './organizations.service';
import { Public } from '../auth/decorators/public.decorator';

const REFRESH_COOKIE_NAME = 'refreshToken';
// architecture/api-contract.md §0: cookie is scoped to the refresh path only.
const REFRESH_COOKIE_PATH = '/api/v1/auth/refresh';
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateOrganizationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, user } = await this.organizationsService.bootstrap(
      dto,
      req.headers['user-agent'],
      req.ip,
    );

    // architecture/api-contract.md §0: the refresh token is never in the
    // JSON body — httpOnly/Secure/SameSite=Strict cookie only.
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: this.configService.get<boolean>('cookie.secure'),
      sameSite: 'strict',
      domain: this.configService.get<string>('cookie.domain'),
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });

    return { accessToken, user };
  }
}
