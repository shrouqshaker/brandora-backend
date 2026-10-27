import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CatalogModule } from './catalog/catalog.module';
import { ImportsModule } from './imports/imports.module';
import { InventoryModule } from './inventory/inventory.module';
import { BusinessesModule } from './businesses/businesses.module';
import { CategoriesModule } from './categories/categories.module';
import { ProductsModule } from './products/products.module';
import { VariantsModule } from './variants/variants.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (env: Record<string, unknown>) => {
        const url = env.DATABASE_URL;
        if (typeof url !== 'string' || !/^postgres(ql)?:\/\//.test(url)) {
          throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
        }
        const port = Number(env.PORT ?? 3000);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error('PORT must be an integer between 1 and 65535.');
        }
        return { ...env, PORT: port };
      },
    }),
    CatalogModule,
    ImportsModule,
    InventoryModule,
    BusinessesModule,
    CategoriesModule,
    ProductsModule,
    VariantsModule,
  ],
})
export class AppModule {}
