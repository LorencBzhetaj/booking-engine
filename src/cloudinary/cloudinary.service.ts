import { Injectable } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';

/**
 * Uploads room photos to Cloudinary. Configured from the CLOUDINARY_URL env var
 * (cloudinary://<api_key>:<api_secret>@<cloud_name>), which the SDK reads
 * automatically. Returns the hosted secure URL to store on rooms.image_url.
 */
@Injectable()
export class CloudinaryService {
  constructor() {
    cloudinary.config({ secure: true });
  }

  isConfigured(): boolean {
    return Boolean(process.env.CLOUDINARY_URL);
  }

  async uploadImage(buffer: Buffer, publicIdHint: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error('Cloudinary is not configured (CLOUDINARY_URL missing)');
    }
    return new Promise<string>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'gjecaj/rooms', public_id: publicIdHint, overwrite: true },
        (error, result) => {
          if (error || !result) return reject(error ?? new Error('upload failed'));
          resolve(result.secure_url);
        },
      );
      stream.end(buffer);
    });
  }
}
