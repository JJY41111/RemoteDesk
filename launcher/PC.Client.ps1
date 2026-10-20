function Get-RemoteDeskPCUrl([string]$Address) {
    $uri = $null
    if (![Uri]::TryCreate($Address.Trim(), [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or !$uri.Host -or $uri.UserInfo -or $uri.Fragment -or
        $uri.AbsolutePath -ne '/') {
        throw '請貼上「跨網路 筆電」提供的 HTTPS 首頁網址，例如 https://100.64.0.10:10443/。'
    }
    $builder = [UriBuilder]::new($uri)
    $query = @($uri.Query.TrimStart('?').Split('&') | Where-Object {
        $_ -and [Uri]::UnescapeDataString(($_ -split '=',2)[0]) -ne 'client'
    })
    $builder.Query = (($query + 'client=pc') -join '&')
    return $builder.Uri.AbsoluteUri
}
