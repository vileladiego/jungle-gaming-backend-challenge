import { MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { buildRuntimeMikroOrmConfig } from './mikro-orm.config';

@Injectable()
class CloseOrmOnShutdown implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

@Global()
@Module({})
export class PersistenceModule {
  static async register(): Promise<DynamicModule> {
    const mikroOrm = await MikroOrmModule.forRoot(buildRuntimeMikroOrmConfig());
    return {
      module: PersistenceModule,
      global: true,
      imports: [mikroOrm],
      providers: [CloseOrmOnShutdown],
      exports: [mikroOrm],
    };
  }
}
