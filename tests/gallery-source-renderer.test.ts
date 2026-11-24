import { describe, expect,it,vi } from 'vitest';
import { checkProxySource } from '../src/main/gallery-source-proxy';
import { publicAddress, validatePublicSource,waitWithSignal } from '../src/main/gallery-source-download';
import { publicImageMime,validateFigureCrop } from '../src/main/gallery-source-renderer';
vi.mock('electron',()=>({app:{},session:{},BrowserWindow:class{}}));

describe('on-demand scholarly source validation',()=>{
  it('allows only public destination addresses, including when a public name redirects',()=>{
    for(const ip of ['::1','::ffff:127.0.0.1','fc00::2','fe80::1','2002::1','2001:db8::1','10.0.0.1','127.0.0.1','169.254.169.254','198.18.0.12','224.0.0.1']) expect(publicAddress(ip),ip).toBe(false);
    for(const ip of ['1.1.1.1','2606:4700:4700::1111']) expect(publicAddress(ip),ip).toBe(true);
  });
  it('does not turn original image requests into a general network proxy',()=>{
    for(const u of ['http://arxiv.org/x','https://arxiv.org:444/x','https://user:password@arxiv.org/x','https://arxiv.org.other.org/x','https://127.1/x','file:///C:/file'])expect(()=>validatePublicSource(u,'image')).toThrow();
    expect(validatePublicSource('https://pubs.rsc.org/x#fig','image').href).toBe('https://pubs.rsc.org/x');
    expect(()=>checkProxySource('https://example.com/a.pdf','pdf')).toThrow();
    expect(checkProxySource('https://www.osti.gov/servlets/purl/123','pdf').hostname).toBe('www.osti.gov');
    expect(()=>checkProxySource('https://media.springernature.com/other/pic.png','image')).toThrow();
    expect(checkProxySource('https://media.springernature.com/full/springer-static/image/Fig1.png','image').hostname).toBe('media.springernature.com');
    expect(validatePublicSource('https://www.osti.gov/servlets/purl/42','pdf').protocol).toBe('https:');
  });
  it('requires valid finite displayed-page coordinates and one-based page numbers',()=>{
    const source={pdfUrl:'https://www.osti.gov/x',page:1,cropPdfPoints:[0,5,150,125]};
    expect(()=>validateFigureCrop(source)).not.toThrow();
    for(const change of [{page:0},{page:0.5},{pdfSha256:'no'},{cropPdfPoints:[5,4,4,9]},{cropPdfPoints:[1,2,8,Infinity]}])expect(()=>validateFigureCrop({...source,...change})).toThrow();
  });
  it('sniffs published image bytes and rejects HTML login notices and PDF responses',()=>{
    for(const [s,m] of [['GIF89a','gif'],['RIFF0000WEBP','webp'],['<?xml version="1.0"?><svg width="10"/>','svg+xml']])expect(publicImageMime(Buffer.from(s))).toBe('image/'+m);
    for(const s of ['<!DOCTYPE html><img src=x>','%PDF-1.7',''])expect(()=>publicImageMime(Buffer.from(s))).toThrow();
  });
  it('allows cancellation while an upstream operation is waiting',async()=>{
    const a=new AbortController();const waiter=waitWithSignal(new Promise<void>(()=>{}),a.signal);
    a.abort(new Error('cancelled'));await expect(waiter).rejects.toThrow('cancelled');
  });
});
