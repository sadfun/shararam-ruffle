import struct, zlib, sys, os, collections

BLEND = {0:'normal',1:'normal',2:'layer',3:'multiply',4:'screen',5:'lighten',6:'darken',7:'difference',8:'add',9:'subtract',10:'invert',11:'alpha',12:'erase',13:'overlay',14:'hardlight'}
FILTER = {0:'dropshadow',1:'blur',2:'glow',3:'bevel',4:'gradglow',5:'convolution',6:'colormatrix',7:'gradbevel'}

class Bits:
    def __init__(s, b, pos=0): s.b=b; s.pos=pos; s.bit=0
    def read(s, n, signed=False):
        v=0
        for _ in range(n):
            v=(v<<1)|((s.b[s.pos]>>(7-s.bit))&1); s.bit+=1
            if s.bit==8: s.bit=0; s.pos+=1
        if signed and n and v>>(n-1): v-=1<<n
        return v
    def align(s):
        if s.bit: s.bit=0; s.pos+=1

def skip_rect(b,p):
    r=Bits(b,p); n=r.read(5); r.read(n*4); r.align(); return r.pos
def skip_matrix(b,p):
    r=Bits(b,p)
    if r.read(1): n=r.read(5); r.read(2*n)
    if r.read(1): n=r.read(5); r.read(2*n)
    n=r.read(5); r.read(2*n); r.align(); return r.pos
def skip_cxform(b,p,alpha=True):
    r=Bits(b,p); a=r.read(1); m=r.read(1); n=r.read(4); k=4 if alpha else 3
    if m: r.read(k*n)
    if a: r.read(k*n)
    r.align(); return r.pos
def cstr(b,p):
    e=b.index(b'\0',p); return b[p:e].decode('latin1'), e+1

def fixed(b,p): return struct.unpack_from('<i',b,p)[0]/65536

def parse_filters(b,p):
    n=b[p]; p+=1; out=[]
    for _ in range(n):
        fid=b[p]; p+=1; name=FILTER.get(fid,'?')
        if fid==0: d=f'blur={fixed(b,p+4):.0f}x{fixed(b,p+8):.0f} dist={fixed(b,p+16):.1f} passes={b[p+22]&31}'; p+=23
        elif fid==1: d=f'blur={fixed(b,p):.0f}x{fixed(b,p+4):.0f} passes={b[p+8]>>3}'; p+=9
        elif fid==2: d=f'blur={fixed(b,p+4):.0f}x{fixed(b,p+8):.0f} strength={struct.unpack_from("<H",b,p+12)[0]/256:.1f} passes={b[p+14]&31} inner={b[p+14]>>7}'; p+=15
        elif fid==3: d=f'blur={fixed(b,p+8):.0f}x{fixed(b,p+12):.0f} passes={b[p+26]&15}'; p+=27
        elif fid in (4,7): nc=b[p]; d=f'colors={nc} blur={fixed(b,p+1+5*nc):.0f}x{fixed(b,p+5+5*nc):.0f} passes={b[p+19+5*nc]&15}'; p+=20+5*nc
        elif fid==5: mx,my=b[p],b[p+1]; d=f'{mx}x{my}'; p+=15+4*mx*my
        elif fid==6: d=''; p+=80
        else: raise ValueError('filter '+str(fid))
        out.append(f'{name}({d})')
    return out,p

def parse_place(b, code, stats, depth_prefix):
    p=0; flags=b[p]; p+=1
    f2 = 0
    if code==70: f2=b[p]; p+=1
    depth=struct.unpack_from('<H',b,p)[0]; p+=2
    if code==70 and (f2&8 or (f2&16 and flags&2)): _,p=cstr(b,p)
    cid=None
    if flags&2: cid=struct.unpack_from('<H',b,p)[0]; p+=2
    if flags&4: p=skip_matrix(b,p)
    if flags&8: p=skip_cxform(b,p)
    if flags&16: p+=2
    name=None
    if flags&32: name,p=cstr(b,p)
    if flags&64: p+=2
    filters=[]; blend=None; cache=None
    if code==70:
        if f2&1: filters,p=parse_filters(b,p)
        if f2&2: blend=BLEND.get(b[p],str(b[p])); p+=1
        if f2&4: cache=b[p]; p+=1
    if filters or (blend and blend!='normal') or cache:
        stats['places'].append((depth_prefix, depth, cid, name, blend, cache, filters))

def walk(b, stats, depth_prefix=''):
    p=0
    while p+2<=len(b):
        h=struct.unpack_from('<H',b,p)[0]; p+=2
        code=h>>6; ln=h&0x3f
        if ln==0x3f: ln=struct.unpack_from('<I',b,p)[0]; p+=4
        body=b[p:p+ln]; p+=ln
        stats['tags'][code]+=1
        if code in (26,70): parse_place(body, code, stats, depth_prefix)
        elif code==39:
            sid,fc=struct.unpack_from('<HH',body,0)
            stats['sprites'].append((sid,fc))
            walk(body[4:], stats, depth_prefix+f'S{sid}/')
        elif code in (20,36):
            cid,fmt,w,hh=struct.unpack_from('<HBHH',body,0); stats['bitmaps'].append((cid,w,hh,'lossless',ln))
        elif code in (6,21,35,90):
            cid=struct.unpack_from('<H',body,0)[0]; stats['bitmaps'].append((cid,None,None,'jpeg',ln))
        elif code in (2,22,32,83):
            stats['shapes']+=1
        elif code in (46,84): stats['morphs']+=1
        if code==0: break

def info(path):
    raw=open(path,'rb').read()
    sig=raw[:3]; ver=raw[3]; total=struct.unpack_from('<I',raw,4)[0]
    if sig==b'CWS': b=zlib.decompress(raw[8:])
    elif sig==b'FWS': b=raw[8:]
    else: raise ValueError(sig)
    p=skip_rect(b,0); r=Bits(b,0); n=r.read(5); xmin,xmax,ymin,ymax=[r.read(n,True)/20 for _ in range(4)]
    fr=struct.unpack_from('<H',b,p)[0]/256; fc=struct.unpack_from('<H',b,p+2)[0]; p+=4
    stats={'tags':collections.Counter(),'places':[],'sprites':[],'bitmaps':[],'shapes':0,'morphs':0}
    walk(b[p:], stats)
    return dict(ver=ver, size=(xmax-xmin,ymax-ymin), fps=fr, frames=fc, packed=len(raw), unpacked=len(b), **stats)

if __name__=='__main__':
    for path in sys.argv[1:]:
        i=info(path)
        print(f'=== {os.path.basename(path)}  v{i["ver"]} {i["size"][0]:.0f}x{i["size"][1]:.0f} {i["fps"]:.0f}fps {i["frames"]}fr  {i["packed"]}B→{i["unpacked"]}B  shapes={i["shapes"]} morphs={i["morphs"]} sprites={len(i["sprites"])} bitmaps={len(i["bitmaps"])}')
        for cid,w,h,kind,ln in i['bitmaps']: print(f'   bitmap #{cid} {kind} {w}x{h} {ln}B')
        for pre,d,cid,name,blend,cache,filters in i['places']:
            print(f'   place {pre}d{d} char={cid} name={name} blend={blend} cache={cache} filters={filters}')
