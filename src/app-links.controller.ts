import { Controller, Get, Header } from '@nestjs/common';
import { AuthScope } from './auth/auth-policy';

@Controller('.well-known')
export class AppLinksController {
  @Get('assetlinks.json')
  @AuthScope('public')
  @Header('Content-Type', 'application/json')
  assetLinks() {
    return [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.yasminhosam.brandora',
          // Development signing certificate; release builds need their own fingerprint.
          sha256_cert_fingerprints: [
            '51:F3:C3:2A:04:7C:8B:34:0B:24:28:DE:8F:80:6F:1F:31:96:EC:AB:93:04:FF:B6:C2:DE:E6:4B:73:56:08:2E',
          ],
        },
      },
    ];
  }
}
