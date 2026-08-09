import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** 预签名上传请求（仅需登录；业务关联时的功能权限由业务保存接口校验） */
export class PresignImageDto {
  @ApiPropertyOptional({ description: '原始文件名（仅用于扩展名提示；服务端不信任其内容）', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  originalFilename?: string;
}

/** 图片正式化请求（校验并重编码临时对象） */
export class FinalizeImageDto {
  @ApiProperty({ description: '客户端已上传的临时对象键（必须属于当前用户）', maxLength: 512 })
  @IsString()
  @MaxLength(512)
  pendingObjectKey!: string;
}

/** 正式图片下载请求 */
export class DownloadImageQuery {
  @ApiProperty({ description: '正式图片对象键（images/ 前缀；拒绝备份等其它前缀）', maxLength: 512 })
  @IsString()
  @MaxLength(512)
  objectKey!: string;
}
