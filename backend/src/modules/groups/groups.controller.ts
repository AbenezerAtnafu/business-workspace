import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { GroupsService } from './groups.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { AddGroupMemberDto } from './dto/add-group-member.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';

@Controller('groups')
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @Get()
  async list(@CurrentUser() claims: AccessTokenClaims) {
    return { data: await this.groupsService.list(claims.organizationId) };
  }

  @Roles('owner', 'admin')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() claims: AccessTokenClaims, @Body() dto: CreateGroupDto) {
    return this.groupsService.create(claims.organizationId, claims.userId, dto);
  }

  @Get(':groupId')
  async getDetail(@CurrentUser() claims: AccessTokenClaims, @Param('groupId', new ParseUUIDPipe()) groupId: string) {
    return this.groupsService.getDetail(claims.organizationId, groupId);
  }

  @Roles('owner', 'admin')
  @Patch(':groupId')
  async update(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.groupsService.update(claims.organizationId, claims.userId, groupId, dto);
  }

  @Roles('owner', 'admin')
  @Delete(':groupId')
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentUser() claims: AccessTokenClaims, @Param('groupId', new ParseUUIDPipe()) groupId: string) {
    await this.groupsService.remove(claims.organizationId, claims.userId, groupId);
    return {};
  }

  @Roles('owner', 'admin')
  @Post(':groupId/members')
  @HttpCode(HttpStatus.CREATED)
  async addMember(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Body() dto: AddGroupMemberDto,
  ) {
    await this.groupsService.addMember(claims.organizationId, claims.userId, groupId, dto.userId);
    return {};
  }

  @Roles('owner', 'admin')
  @Delete(':groupId/members/:userId')
  @HttpCode(HttpStatus.OK)
  async removeMember(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    await this.groupsService.removeMember(claims.organizationId, claims.userId, groupId, userId);
    return {};
  }
}
