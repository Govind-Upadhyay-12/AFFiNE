import { HttpStatus, Logger, UseGuards } from '@nestjs/common';
import {
  Args,
  Float,
  Int,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import GraphQLUpload from 'graphql-upload/GraphQLUpload.mjs';

import {
  CloudThrottlerGuard,
  type FileUpload,
  MakeCache,
  PreventCache,
} from '../../../fundamentals';
import { Auth, CurrentUser } from '../../auth';
import { FeatureManagementService, FeatureType } from '../../features';
import { QuotaManagementService } from '../../quota';
import { WorkspaceBlobStorage } from '../../storage';
import { UserType } from '../../users';
import { PermissionService } from '../permission';
import { Permission, WorkspaceBlobSizes, WorkspaceType } from '../types';

@UseGuards(CloudThrottlerGuard)
@Auth()
@Resolver(() => WorkspaceType)
export class WorkspaceBlobResolver {
  logger = new Logger(WorkspaceBlobResolver.name);
  constructor(
    private readonly permissions: PermissionService,
    private readonly feature: FeatureManagementService,
    private readonly quota: QuotaManagementService,
    private readonly storage: WorkspaceBlobStorage
  ) {}

  @ResolveField(() => [String], {
    description: 'List blobs of workspace',
    complexity: 2,
  })
  async blobs(
    @CurrentUser() user: UserType,
    @Parent() workspace: WorkspaceType
  ) {
    await this.permissions.checkWorkspace(workspace.id, user.id);

    return this.storage
      .list(workspace.id)
      .then(list => list.map(item => item.key));
  }

  @ResolveField(() => Int, {
    description: 'Blobs size of workspace',
    complexity: 2,
  })
  async blobsSize(@Parent() workspace: WorkspaceType) {
    return this.storage.totalSize(workspace.id);
  }

  /**
   * @deprecated use `workspace.blobs` instead
   */
  @Query(() => [String], {
    description: 'List blobs of workspace',
    deprecationReason: 'use `workspace.blobs` instead',
  })
  @MakeCache(['blobs'], ['workspaceId'])
  async listBlobs(
    @CurrentUser() user: UserType,
    @Args('workspaceId') workspaceId: string
  ) {
    await this.permissions.checkWorkspace(workspaceId, user.id);

    return this.storage
      .list(workspaceId)
      .then(list => list.map(item => item.key));
  }

  /**
   * @deprecated use `user.storageUsage` instead
   */
  @Query(() => WorkspaceBlobSizes, {
    deprecationReason: 'use `user.storageUsage` instead',
  })
  async collectAllBlobSizes(@CurrentUser() user: UserType) {
    const size = await this.quota.getUserUsage(user.id);
    return { size };
  }

  /**
   * @deprecated mutation `setBlob` will check blob limit & quota usage
   */
  @Query(() => WorkspaceBlobSizes, {
    deprecationReason: 'no more needed',
  })
  async checkBlobSize(
    @CurrentUser() user: UserType,
    @Args('workspaceId') workspaceId: string,
    @Args('size', { type: () => Float }) blobSize: number
  ) {
    const canWrite = await this.permissions.tryCheckWorkspace(
      workspaceId,
      user.id,
      Permission.Write
    );
    if (canWrite) {
      const size = await this.quota.checkBlobQuota(workspaceId, blobSize);
      return { size };
    }
    return false;
  }

  @Mutation(() => String)
  @PreventCache(['blobs'], ['workspaceId'])
  async setBlob(
    @CurrentUser() user: UserType,
    @Args('workspaceId') workspaceId: string,
    @Args({ name: 'blob', type: () => GraphQLUpload })
    blob: FileUpload
  ) {
    await this.permissions.checkWorkspace(
      workspaceId,
      user.id,
      Permission.Write
    );

    const { quota, size, limit } =
      await this.quota.getWorkspaceUsage(workspaceId);

    const unlimited = await this.feature.hasWorkspaceFeature(
      workspaceId,
      FeatureType.UnlimitedWorkspace
    );

    const checkExceeded = (recvSize: number) => {
      if (!quota) {
        throw new GraphQLError('cannot find user quota', {
          extensions: {
            status: HttpStatus[HttpStatus.FORBIDDEN],
            code: HttpStatus.FORBIDDEN,
          },
        });
      }
      const total = size + recvSize;
      // only skip total storage check if workspace has unlimited feature
      if (total > quota && !unlimited) {
        this.logger.log(`storage size limit exceeded: ${total} > ${quota}`);
        return true;
      } else if (recvSize > limit) {
        this.logger.log(`blob size limit exceeded: ${recvSize} > ${limit}`);
        return true;
      } else {
        return false;
      }
    };

    if (checkExceeded(0)) {
      throw new GraphQLError('storage or blob size limit exceeded', {
        extensions: {
          status: HttpStatus[HttpStatus.PAYLOAD_TOO_LARGE],
          code: HttpStatus.PAYLOAD_TOO_LARGE,
        },
      });
    }
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const stream = blob.createReadStream();
      const chunks: Uint8Array[] = [];
      stream.on('data', chunk => {
        chunks.push(chunk);

        // check size after receive each chunk to avoid unnecessary memory usage
        const bufferSize = chunks.reduce((acc, cur) => acc + cur.length, 0);
        if (checkExceeded(bufferSize)) {
          reject(
            new GraphQLError('storage or blob size limit exceeded', {
              extensions: {
                status: HttpStatus[HttpStatus.PAYLOAD_TOO_LARGE],
                code: HttpStatus.PAYLOAD_TOO_LARGE,
              },
            })
          );
        }
      });
      stream.on('error', reject);
      stream.on('end', () => {
        const buffer = Buffer.concat(chunks);

        if (checkExceeded(buffer.length)) {
          reject(
            new GraphQLError('storage limit exceeded', {
              extensions: {
                status: HttpStatus[HttpStatus.PAYLOAD_TOO_LARGE],
                code: HttpStatus.PAYLOAD_TOO_LARGE,
              },
            })
          );
        } else {
          resolve(buffer);
        }
      });
    });

    await this.storage.put(workspaceId, blob.filename, buffer);
    return blob.filename;
  }

  @Mutation(() => Boolean)
  @PreventCache(['blobs'], ['workspaceId'])
  async deleteBlob(
    @CurrentUser() user: UserType,
    @Args('workspaceId') workspaceId: string,
    @Args('hash') name: string
  ) {
    await this.permissions.checkWorkspace(workspaceId, user.id);

    await this.storage.delete(workspaceId, name);

    return true;
  }
}
