import { join } from 'path';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import hbs from 'hbs';
import methodOverride from 'method-override';
import { basicAuth } from './admin/basic-auth';

/**
 * Shared runtime configuration applied identically by the real bootstrap
 * (main.ts) and by e2e tests, so both exercise the same middleware/view stack.
 * Views live in <project>/views (not compiled into dist), resolved via cwd.
 */
export function configureApp(app: NestExpressApplication): void {
  const viewsDir = join(process.cwd(), 'views');
  app.setBaseViewsDir(viewsDir);
  app.setViewEngine('hbs');
  hbs.registerPartials(join(viewsDir, 'partials'));

  // View helpers (presentation only — no business logic).
  hbs.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  hbs.registerHelper('selected', (a: unknown, b: unknown) =>
    a === b ? 'selected' : '',
  );

  // Let HTML forms send PUT/DELETE via a hidden _method field.
  app.use(methodOverride('_method'));

  // Protect the whole admin surface with Basic Auth.
  app.use('/admin', basicAuth);

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
}
