import { randomUUID } from "node:crypto";
import { notionPaginate, notionRequest, NotionError, type NotionClientDeps } from "./client";
import type { NotionObject } from "./types";

export interface NotionOpsDeps extends NotionClientDeps {}
const id=(value:string)=>encodeURIComponent(value);
const receipt=(value:unknown,object?:string):NotionObject=>{if(!value||typeof value!=="object")throw new NotionError("malformed_response");const r=value as NotionObject;if(typeof r.id!=="string"||(object&&r.object!==object))throw new NotionError("malformed_response");return r;};
const targetReceipt=(value:unknown,targetId:string,object:string):NotionObject=>{const result=receipt(value,object);if(result.id?.replaceAll("-","")!==targetId.replaceAll("-",""))throw new NotionError("malformed_response");return result;};

export const notionOps={
  search:(u:string,body:Record<string,unknown>,d?:NotionOpsDeps)=>{const{limit,...providerBody}=body;return notionPaginate(u,{method:"POST",path:"/search",body:providerBody,safeRetry:true},{maxResults:typeof limit==="number"?limit:typeof body.page_size==="number"?body.page_size:100,deps:d});},
  users:(u:string,d?:NotionOpsDeps)=>notionPaginate(u,{method:"GET",path:"/users",safeRetry:true},{deps:d}),
  me:(u:string,d?:NotionOpsDeps)=>notionRequest<NotionObject>(u,{method:"GET",path:"/users/me",safeRetry:true},d),
  page:(u:string,pageId:string,d?:NotionOpsDeps)=>notionRequest<NotionObject>(u,{method:"GET",path:`/pages/${id(pageId)}`,safeRetry:true},d),
  pageProperty:(u:string,pageId:string,propertyId:string,d?:NotionOpsDeps)=>notionRequest<unknown>(u,{method:"GET",path:`/pages/${id(pageId)}/properties/${id(propertyId)}`,safeRetry:true},d),
  pagePropertyItems:(u:string,pageId:string,propertyId:string,d?:NotionOpsDeps)=>notionPaginate(u,{method:"GET",path:`/pages/${id(pageId)}/properties/${id(propertyId)}`,safeRetry:true},{maxResults:500,deps:d}),
  movePage:async(u:string,pageId:string,parent:Record<string,unknown>,d?:NotionOpsDeps)=>targetReceipt(await notionRequest(u,{method:"POST",path:`/pages/${id(pageId)}/move`,body:{parent}},d),pageId,"page"),
  database:(u:string,databaseId:string,d?:NotionOpsDeps)=>notionRequest<NotionObject>(u,{method:"GET",path:`/databases/${id(databaseId)}`,safeRetry:true},d),
  dataSource:(u:string,dataSourceId:string,d?:NotionOpsDeps)=>notionRequest<NotionObject>(u,{method:"GET",path:`/data_sources/${id(dataSourceId)}`,safeRetry:true},d),
  query:(u:string,dataSourceId:string,body:Record<string,unknown>,d?:NotionOpsDeps)=>{const{limit,...providerBody}=body;return notionPaginate(u,{method:"POST",path:`/data_sources/${id(dataSourceId)}/query`,body:providerBody,safeRetry:true},{maxResults:typeof limit==="number"?limit:typeof body.page_size==="number"?body.page_size:100,deps:d});},
  block:(u:string,blockId:string,d?:NotionOpsDeps)=>notionRequest<NotionObject>(u,{method:"GET",path:`/blocks/${id(blockId)}`,safeRetry:true},d),
  children:(u:string,blockId:string,d?:NotionOpsDeps)=>notionPaginate(u,{method:"GET",path:`/blocks/${id(blockId)}/children`,safeRetry:true},{maxResults:500,deps:d}),
  comments:(u:string,target:{block_id?:string;page_id?:string},d?:NotionOpsDeps)=>notionPaginate(u,{method:"GET",path:"/comments",query:target,safeRetry:true},{maxResults:100,deps:d}),
  comment:(u:string,commentId:string,d?:NotionOpsDeps)=>notionRequest<NotionObject>(u,{method:"GET",path:`/comments/${id(commentId)}`,safeRetry:true},d),
  createPage:async(u:string,body:Record<string,unknown>,d?:NotionOpsDeps)=>receipt(await notionRequest(u,{method:"POST",path:"/pages",body,idempotencyKey:randomUUID()},d),"page"),
  updatePage:async(u:string,pageId:string,body:Record<string,unknown>,d?:NotionOpsDeps)=>targetReceipt(await notionRequest(u,{method:"PATCH",path:`/pages/${id(pageId)}`,body},d),pageId,"page"),
  appendBlocks:async(u:string,blockId:string,children:unknown[],d?:NotionOpsDeps)=>notionRequest<NotionObject>(u,{method:"PATCH",path:`/blocks/${id(blockId)}/children`,body:{children},idempotencyKey:randomUUID()},d),
  updateBlock:async(u:string,blockId:string,body:Record<string,unknown>,d?:NotionOpsDeps)=>targetReceipt(await notionRequest(u,{method:"PATCH",path:`/blocks/${id(blockId)}`,body},d),blockId,"block"),
  archiveBlock:(u:string,blockId:string,d?:NotionOpsDeps)=>notionOps.updateBlock(u,blockId,{in_trash:true},d),
  createComment:async(u:string,body:Record<string,unknown>,d?:NotionOpsDeps)=>receipt(await notionRequest(u,{method:"POST",path:"/comments",body,idempotencyKey:randomUUID()},d),"comment"),
  updateComment:async(u:string,commentId:string,body:Record<string,unknown>,d?:NotionOpsDeps)=>targetReceipt(await notionRequest(u,{method:"PATCH",path:`/comments/${id(commentId)}`,body},d),commentId,"comment"),
  deleteComment:async(u:string,commentId:string,d?:NotionOpsDeps)=>targetReceipt(await notionRequest(u,{method:"DELETE",path:`/comments/${id(commentId)}`},d),commentId,"comment"),
  createDataSource:async(u:string,body:Record<string,unknown>,d?:NotionOpsDeps)=>receipt(await notionRequest(u,{method:"POST",path:"/data_sources",body,idempotencyKey:randomUUID()},d),"data_source"),
  updateDataSource:async(u:string,dataSourceId:string,body:Record<string,unknown>,d?:NotionOpsDeps)=>targetReceipt(await notionRequest(u,{method:"PATCH",path:`/data_sources/${id(dataSourceId)}`,body},d),dataSourceId,"data_source"),
  fileUploads:(u:string,d?:NotionOpsDeps)=>notionPaginate(u,{method:"GET",path:"/file_uploads",safeRetry:true},{maxResults:100,deps:d}),
  createFileUpload:async(u:string,body:Record<string,unknown>,d?:NotionOpsDeps)=>receipt(await notionRequest(u,{method:"POST",path:"/file_uploads",body,idempotencyKey:randomUUID()},d),"file_upload"),
  completeFileUpload:async(u:string,fileId:string,d?:NotionOpsDeps)=>receipt(await notionRequest(u,{method:"POST",path:`/file_uploads/${id(fileId)}/complete`,body:{}},d),"file_upload"),
};
